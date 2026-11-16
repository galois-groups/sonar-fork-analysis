CREATE TABLE "order" (
  id integer PRIMARY KEY,
  customer text NOT NULL,
  total numeric(10, 2) NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now()
);
