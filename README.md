# VIZORA AI
1. `npm install`
2. Run `schema.sql` on your PostgreSQL database
3. Edit `.env`: DATABASE_URL, JWT_SECRET, GEMINI_API_KEY (already set), APP_URL (public https URL)
4. `npm start` -> http://localhost:3000

Payments: FamGateway (UPI). Connect FamPay Gmail (IMAP on) in your FamGateway dashboard first.
Credits are added only after the server verifies the order with FamGateway (webhook + return-page polling).
Never commit `.env`.

Images: Gemini image model via generativelanguage.googleapis.com (set GEMINI_IMAGE_MODEL to change).
