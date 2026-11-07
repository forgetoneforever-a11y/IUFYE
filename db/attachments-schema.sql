-- IUFYE Stage 4: private file and image attachments
-- Apply after db/schema.sql and db/chat-schema.sql.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS attachment_path TEXT,
  ADD COLUMN IF NOT EXISTS attachment_name TEXT,
  ADD COLUMN IF NOT EXISTS attachment_mime TEXT,
  ADD COLUMN IF NOT EXISTS attachment_size BIGINT;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_message_type_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_message_type_check
  CHECK (message_type IN ('text', 'image', 'file'));

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_attachment_shape_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_attachment_shape_check CHECK (
    (message_type = 'text'
      AND attachment_path IS NULL
      AND attachment_name IS NULL
      AND attachment_mime IS NULL
      AND attachment_size IS NULL)
    OR
    (message_type IN ('image', 'file')
      AND attachment_path IS NOT NULL
      AND attachment_name IS NOT NULL
      AND char_length(attachment_name) BETWEEN 1 AND 120
      AND attachment_mime IS NOT NULL
      AND attachment_size BETWEEN 1 AND 15728640)
  );
