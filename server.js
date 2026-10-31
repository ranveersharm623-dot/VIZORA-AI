require('dotenv').config();
const express=require('express'),{Pool}=require('pg'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),
crypto=require('crypto'),fs=require('fs'),path=require('path'),cookieParser=require('cookie-parser'),rateLimit=require('express-rate-limit');
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const E=process.env, PACKS=[20,40,60,80,100], STORE=path.join(__dirname,'storage');
fs.mkdirSync(STORE,{recursive:true});
const app=express(); app.set('trust proxy',1);

// ---------- FamGateway payments ----------
const FG='https://famgateway.in/api';
const fgHeaders={'Content-Type':'application/json','X-Api-Key':E.FAMGATEWAY_API_KEY};

// Verifies the order with FamGateway (server-to-server) and credits it exactly once.
async function fulfill(orderId){
 const o=(await pool.query('SELECT id,user_id,credits,amount_inr,status,gateway_order_id FROM payment_orders WHERE id=$1',[orderId])).rows[0];
 if(!o)return 'not_found'; if(o.status==='paid')return 'paid'; if(!o.gateway_order_id)return o.status;
 const r=await fetch(`${FG}/verify-order.php?order_id=${encodeURIComponent(o.gateway_order_id)}`,{headers:{'X-Api-Key':E.FAMGATEWAY_API_KEY}});
 const j=await r.json().catch(()=>({}));
 if(j.status==='expired'){await pool.query(`UPDATE payment_orders SET status='expired' WHERE id=$1 AND status='pending'`,[o.id]);return 'expired'}
 if(!(j.status==='success'&&j.data&&j.data.utr))return 'pending';
 const paid=+j.data.amount; // gateway may add up to a few paise to keep amounts unique
 if(!(paid>=o.amount_inr&&paid<=o.amount_inr+0.5)){await pool.query(`UPDATE payment_orders SET status='mismatch' WHERE id=$1 AND status IN ('pending','expired')`,[o.id]);return 'mismatch'}
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const u=await c.query(`UPDATE payment_orders SET status='paid',payment_id=$2,paid_at=now() WHERE id=$1 AND status IN ('pending','expired') RETURNING user_id,credits`,[o.id,String(j.data.utr)]);
  if(u.rowCount){
   await c.query('UPDATE users SET credits=credits+$2 WHERE id=$1',[u.rows[0].user_id,u.rows[0].credits]);
   await c.query(`INSERT INTO credit_transactions(user_id,delta,type,ref) VALUES($1,$2,'purchase',$3)`,[u.rows[0].user_id,u.rows[0].credits,'pay:'+o.id]);
  }
  await c.query('COMMIT');return 'paid';
 }catch(e){await c.query('ROLLBACK');console.error('fulfill',e.message);return 'error'}finally{c.release()}
}
app.post('/api/payment/webhook',express.raw({type:'*/*'}),async(req,res)=>{
 try{
  const sig=String(req.get('x-famgateway-signature')||'');
  const exp=crypto.createHmac('sha256',E.FAMGATEWAY_API_KEY).update(req.body).digest('hex');
  if(sig.length!==exp.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(exp)))return res.sendStatus(401);
  const p=JSON.parse(req.body.toString());
  if(p.event==='payment.success'||p.status==='success'){
   const o=await pool.query('SELECT id FROM payment_orders WHERE gateway_order_id=$1',[p.order_id]);
   if(o.rowCount)await fulfill(o.rows[0].id); // re-verified with the gateway, never trusts webhook body alone
  }
  res.status(200).send('OK');
 }catch(e){console.error('webhook',e.message);res.sendStatus(500)}
});

app.use(express.json({limit:'50kb'}));app.use(cookieParser());
app.use(express.static(path.join(__dirname,'public')));

// ---------- Auth ----------
const sign=id=>jwt.sign({id},E.JWT_SECRET,{expiresIn:'7d'});
const setCookie=(res,id)=>res.cookie('token',sign(id),{httpOnly:true,sameSite:'lax',secure:E.NODE_ENV==='production',maxAge:6048e5});
const auth=(req,res,next)=>{try{req.uid=jwt.verify(req.cookies.token,E.JWT_SECRET).id;next()}catch{res.status(401).json({error:'Login required'})}};
const authLimit=rateLimit({windowMs:15*60e3,max:30}), genLimit=rateLimit({windowMs:60e3,max:6});

app.post('/api/register',authLimit,async(req,res)=>{
 const {username,email,password,confirm}=req.body||{};
 if(!/^[\w.-]{3,30}$/.test(username||''))return res.status(400).json({error:'Username: 3-30 letters/numbers'});
 if(!/^\S+@\S+\.\S+$/.test(email||''))return res.status(400).json({error:'Invalid email'});
 if(!password||password.length<8)return res.status(400).json({error:'Password must be 8+ characters'});
 if(password!==confirm)return res.status(400).json({error:'Passwords do not match'});
 try{
  const r=await pool.query('INSERT INTO users(username,email,password_hash) VALUES($1,$2,$3) RETURNING id',
   [username,email.toLowerCase(),await bcrypt.hash(password,12)]);
  setCookie(res,r.rows[0].id);res.json({ok:true});
 }catch(e){res.status(409).json({error:'Username or email already exists'})}
});
app.post('/api/login',authLimit,async(req,res)=>{
 const {email,password}=req.body||{};
 const r=await pool.query('SELECT id,password_hash FROM users WHERE email=$1',[String(email||'').toLowerCase()]);
 if(!r.rowCount||!await bcrypt.compare(String(password||''),r.rows[0].password_hash))return res.status(401).json({error:'Wrong email or password'});
 setCookie(res,r.rows[0].id);res.json({ok:true});
});
app.post('/api/logout',(req,res)=>{res.clearCookie('token');res.json({ok:true})});
app.get('/api/me',auth,async(req,res)=>{
 const r=await pool.query(`SELECT username,email,credits,(SELECT count(*) FROM images WHERE user_id=$1)::int AS total_images FROM users WHERE id=$1`,[req.uid]);
 r.rowCount?res.json(r.rows[0]):res.status(401).json({error:'Login required'});
});

// ---------- Generation ----------
async function callAI({prompt,negative,style,aspect}){
 const text=[style?`${prompt}, ${style} style`:prompt,negative?`Avoid: ${negative}`:''].filter(Boolean).join('. ');
 const models=[E.GEMINI_IMAGE_MODEL||'gemini-3.1-flash-image','gemini-3.1-flash-image-preview','gemini-2.5-flash-image'];
 let last;
 for(const m of models){
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,{
   method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':E.GEMINI_API_KEY},signal:AbortSignal.timeout(90000),
   body:JSON.stringify({contents:[{parts:[{text}]}],generationConfig:{responseModalities:['TEXT','IMAGE'],imageConfig:{aspectRatio:aspect}}})});
  if(r.status===404){last=new Error('model not found: '+m);continue}   // try next model name
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error('Gemini '+r.status+' '+(j.error&&j.error.message||''));
  const parts=(j.candidates&&j.candidates[0]&&j.candidates[0].content&&j.candidates[0].content.parts)||[];
  const img=parts.filter(p=>!p.thought).map(p=>p.inlineData||p.inline_data).find(Boolean);
  if(!img||!img.data)throw new Error('No image returned (blocked or empty): '+(j.promptFeedback&&j.promptFeedback.blockReason||j.candidates&&j.candidates[0]&&j.candidates[0].finishReason||'unknown'));
  return Buffer.from(img.data,'base64');
 }
 throw last||new Error('No Gemini image model available');
}
app.post('/api/generate',auth,genLimit,async(req,res)=>{
 const prompt=String(req.body.prompt||'').trim(),negative=String(req.body.negative||'').slice(0,500),
  style=String(req.body.style||'').slice(0,40),aspect=['1:1','16:9','9:16','4:3'].includes(req.body.aspect)?req.body.aspect:'1:1';
 if(prompt.length<3||prompt.length>1000)return res.status(400).json({error:'Prompt must be 3-1000 characters'});
 const b=await pool.query('SELECT credits FROM users WHERE id=$1',[req.uid]);
 if(!b.rowCount||b.rows[0].credits<1)return res.status(402).json({error:'INSUFFICIENT_CREDITS'});
 let buf;
 try{buf=await callAI({prompt,negative,style,aspect})}
 catch(e){console.error('ai',e.message);return res.status(502).json({error:'Image generation failed. No credit was used.'})}
 const id=crypto.randomUUID(),file=id+'.png',fp=path.join(STORE,file),c=await pool.connect();
 try{
  await c.query('BEGIN');
  const d=await c.query('UPDATE users SET credits=credits-1 WHERE id=$1 AND credits>=1 RETURNING credits',[req.uid]);
  if(!d.rowCount){await c.query('ROLLBACK');return res.status(402).json({error:'INSUFFICIENT_CREDITS'})}
  await c.query(`INSERT INTO credit_transactions(user_id,delta,type,ref) VALUES($1,-1,'generation',$2)`,[req.uid,'gen:'+id]);
  await c.query('INSERT INTO images(id,user_id,prompt,negative_prompt,style,aspect,file) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,req.uid,prompt,negative,style,aspect,file]);
  fs.writeFileSync(fp,buf);await c.query('COMMIT');
  res.json({id,credits:d.rows[0].credits});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});fs.rmSync(fp,{force:true});console.error(e);res.status(500).json({error:'Could not save image. No credit was used.'})}
 finally{c.release()}
});

// ---------- Library, history ----------
app.get('/api/images',auth,async(req,res)=>res.json((await pool.query('SELECT id,prompt,style,aspect,is_favorite,created_at FROM images WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200',[req.uid])).rows));
app.get('/api/images/:id/file',auth,async(req,res)=>{
 const r=await pool.query('SELECT file FROM images WHERE id=$1 AND user_id=$2',[req.params.id,req.uid]);
 if(!r.rowCount)return res.sendStatus(404);
 if(req.query.dl)res.attachment('vizora-'+req.params.id+'.png');
 res.set('Cache-Control','private, max-age=3600').type('png').sendFile(path.join(STORE,r.rows[0].file));
});
app.post('/api/images/:id/favorite',auth,async(req,res)=>{await pool.query('UPDATE images SET is_favorite=NOT is_favorite WHERE id=$1 AND user_id=$2',[req.params.id,req.uid]);res.json({ok:true})});
app.delete('/api/images/:id',auth,async(req,res)=>{
 const r=await pool.query('DELETE FROM images WHERE id=$1 AND user_id=$2 RETURNING file',[req.params.id,req.uid]);
 if(r.rowCount)fs.rmSync(path.join(STORE,r.rows[0].file),{force:true});res.json({ok:true});
});
app.get('/api/transactions',auth,async(req,res)=>res.json({
 credits:(await pool.query('SELECT delta,type,created_at FROM credit_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[req.uid])).rows,
 payments:(await pool.query('SELECT amount_inr,credits,status,created_at FROM payment_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',[req.uid])).rows}));

// ---------- Buy credits ----------
app.post('/api/orders',auth,async(req,res)=>{
 const amount=+req.body.amount;if(!PACKS.includes(amount))return res.status(400).json({error:'Invalid package'});
 const id=crypto.randomUUID();
 await pool.query('INSERT INTO payment_orders(id,user_id,credits,amount_inr) VALUES($1,$2,$3,$3)',[id,req.uid,amount]);
 try{
  const r=await fetch(FG+'/create-order',{method:'POST',headers:fgHeaders,body:JSON.stringify({amount,
   customer_name:'vizora-'+req.uid.slice(0,8),redirect_url:`${E.APP_URL}/?order=${id}`,webhook_url:`${E.APP_URL}/api/payment/webhook`})});
  const j=await r.json();
  if(!r.ok||j.status!=='success')throw new Error(j.message||'gateway '+r.status);
  await pool.query('UPDATE payment_orders SET gateway_order_id=$2 WHERE id=$1',[id,j.data.order_id]);
  res.json({order_id:id,checkout_url:j.data.checkout_url});
 }catch(e){console.error('order',e.message);await pool.query(`UPDATE payment_orders SET status='failed' WHERE id=$1`,[id]);res.status(502).json({error:'Payment could not start. Try again.'})}
});
// Polled by the site after returning from checkout; verifies with the gateway on the server.
app.get('/api/orders/:id/status',auth,async(req,res)=>{
 const o=await pool.query('SELECT 1 FROM payment_orders WHERE id=$1 AND user_id=$2',[req.params.id,req.uid]);
 if(!o.rowCount)return res.sendStatus(404);
 res.json({status:await fulfill(req.params.id)});
});

app.listen(E.PORT||3000,()=>console.log('VIZORA AI running'));
