-- Contacto privado para responder solicitudes hechas desde la web.
CREATE TABLE IF NOT EXISTS book_request_contacts (
  request_id TEXT PRIMARY KEY REFERENCES book_requests(id) ON DELETE CASCADE,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('email','whatsapp')),
  contact_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  notification_sent_at TEXT
);
