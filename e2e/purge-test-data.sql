-- Removes statistics created by the end-to-end test (visitor ids starting with "e2e-").
--   npx wrangler d1 execute kharbasha-analytics --remote --file e2e/purge-test-data.sql
DELETE FROM turns WHERE game IN (SELECT id FROM games WHERE room IN (SELECT room FROM joins WHERE visitor LIKE 'e2e-%'));
DELETE FROM games WHERE room IN (SELECT room FROM joins WHERE visitor LIKE 'e2e-%');
DELETE FROM rooms WHERE visitor LIKE 'e2e-%' OR code IN (SELECT room FROM joins WHERE visitor LIKE 'e2e-%');
DELETE FROM voice WHERE visitor LIKE 'e2e-%';
DELETE FROM joins WHERE visitor LIKE 'e2e-%';
DELETE FROM visits WHERE visitor LIKE 'e2e-%';
