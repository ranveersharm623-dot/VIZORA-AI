CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE users(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 username text UNIQUE NOT NULL, email text UNIQUE NOT NULL, password_hash text NOT NULL,
 credits int NOT NULL DEFAULT 0 CHECK (credits >= 0), created_at timestamptz DEFAULT now());
CREATE TABLE credit_transactions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id), delta int NOT NULL, type text NOT NULL,
 ref text UNIQUE NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE payment_orders(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id), credits int NOT NULL, amount_inr int NOT NULL,
 status text NOT NULL DEFAULT 'pending', gateway_order_id text, payment_id text UNIQUE,
 created_at timestamptz DEFAULT now(), paid_at timestamptz);
CREATE TABLE images(
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 prompt text NOT NULL, negative_prompt text, style text, aspect text, file text NOT NULL,
 is_favorite boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE INDEX ON images(user_id, created_at DESC);
CREATE INDEX ON credit_transactions(user_id, created_at DESC);
