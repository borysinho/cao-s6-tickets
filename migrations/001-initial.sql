CREATE TABLE ticket_batches (
  order_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  event_id uuid NOT NULL,
  request jsonb NOT NULL,
  ready boolean NOT NULL DEFAULT false
);

CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES ticket_batches(order_id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 6),
  code text NOT NULL UNIQUE,
  UNIQUE (order_id, ordinal)
);

CREATE INDEX ticket_batches_customer ON ticket_batches (customer_id);
