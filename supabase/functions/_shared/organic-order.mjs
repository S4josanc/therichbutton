// Keep attribution optional even during a database schema-cache refresh. Only
// explicit column/FK rejections guarantee that PostgreSQL did not commit.
export async function writeOrganicOrder(table, fields, write) {
  const result = await write(fields);
  if (!fields.organic_post_id || !result.error) return result;
  const { code, message = '' } = result.error;
  const missingField = (code === 'PGRST204' || code === '42703') &&
    /\b(organic_post_id|organic_verified_at)\b/.test(message);
  const missingPost = code === '23503' && message.includes('"' + table + '_organic_post_id_fkey"');
  return missingField || missingPost ? write({}) : result;
}
