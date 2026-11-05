export function audit(ctx, action, entity, entityId, detail) {
  const u = ctx.user;
  ctx.db.prepare(
    'INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)'
  ).run(
    u?.id ?? null,
    u?.name ?? 'system',
    action,
    entity,
    entityId ?? null,
    detail === undefined ? null : typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 2000)
  );
}
