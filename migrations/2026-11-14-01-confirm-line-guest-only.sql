-- 2026-11-14-01 · The check-in confirmation is the guest's receipt, not a
-- note to the host (owner, 14 Nov 2026).
--
-- "The guest confirmed this place is real and as listed. Thank you." was
-- posted to the shared thread, so the host read it too — and what it told
-- a host who had done nothing wrong was that Aerva had asked their guest
-- to vouch for them. The check costs the host nothing and changes nothing,
-- so there is nothing in it they need.
--
-- The code now posts it with audience = 'guest'. This moves the lines
-- already sitting in threads, and rewords them to address the guest, who
-- is now the only one reading them.
--
-- Safe to run more than once.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'messages' AND column_name = 'audience') THEN

    UPDATE messages
       SET audience = 'guest',
           display_text  = 'You confirmed this place is real and as listed. Thank you.',
           original_text = 'You confirmed this place is real and as listed. Thank you.'
     WHERE sender_type = 'system'
       AND COALESCE(audience, '') <> 'guest'
       AND display_text LIKE 'The guest confirmed this place is real and as listed%';

  END IF;
END $$;
