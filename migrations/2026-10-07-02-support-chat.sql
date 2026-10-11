-- 2026-10-07-02-support-chat.sql — the Aerva Support chat in Messages.
-- Applied from Admin → Database updates. Safe to run more than once.

-- Where a request came from: 'web' (Resolution Center form) or 'chat'
-- (handed over from the Support chat in Messages).
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'web';

-- How each message in a request's timeline arrived: NULL (website),
-- 'chat' (typed in the Support chat), 'chat-transcript' (the conversation
-- with the assistant, attached when it was handed to a person).
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS via TEXT;

-- The conversation with Aerva's assistant, per account. Once it is handed
-- to a person, what follows lives on the request (support_messages).
CREATE TABLE IF NOT EXISTS support_chat_messages (
  id         SERIAL PRIMARY KEY,
  guest_id   INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  body       TEXT NOT NULL,
  ticket_id  INTEGER REFERENCES support_tickets(id) ON DELETE SET NULL,
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_chat_messages_guest_idx ON support_chat_messages (guest_id, created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_chat_idx ON support_tickets (guest_id, channel, status);
