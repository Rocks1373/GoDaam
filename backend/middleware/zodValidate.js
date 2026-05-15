/** Attach `req.validatedBody` after successful parse. */
function zodValidate(schema) {
  return (req, res, next) => {
    const r = schema.safeParse(req.body);
    if (!r.success) {
      return res.status(400).json({ error: 'Validation failed', details: r.error.flatten() });
    }
    req.validatedBody = r.data;
    return next();
  };
}

module.exports = { zodValidate };
