// The caller's identity, if the gateway attached one.
//
// censor.lost.plus is fronted by the Common Auth cloud gateway (`auth-gateway`
// Worker), which reaches this Worker over a service binding. Its `/mcp` route
// is `allow_anonymous`: a caller with no credential is forwarded with no
// identity headers at all, and a caller presenting a Common Auth token is
// forwarded with `x-lost-plus-{sub,email,name,role,encoding}` set by the
// gateway after the hub vouched for it. The credential itself never gets here
// (the gateway strips `Authorization` and `x-api-key`), so there is nothing to
// validate in this repo and nothing that reads `Authorization`.
//
// Identity is optional for censor. It is read for attribution only; no tool is
// gated on it, and a request without it is served exactly like one with it.
// A malformed set is treated as "no identity", never as a refusal.
//
// Values are percent-encoded by the gateway (everything outside
// `A-Z a-z 0-9 * - . _`, with `+` rewritten to `%20`), so `decodeURIComponent`
// is the right decoder and a literal `+` is a literal `+`.

const ENCODING = 'percent-utf8';

function decoded(raw) {
  if (raw === null) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** `{ sub, email, name, role }` when the gateway attached a complete identity, else null. */
export function identityFrom(headers) {
  if (headers.get('x-lost-plus-encoding') !== ENCODING) return null;
  const sub = decoded(headers.get('x-lost-plus-sub'));
  const email = decoded(headers.get('x-lost-plus-email'));
  const name = decoded(headers.get('x-lost-plus-name'));
  const role = decoded(headers.get('x-lost-plus-role'));
  if (!sub || !email || !name || !role) return null;
  return { sub, email, name, role };
}
