// Raised for any bad input; the message is safe to show the caller.
// Lives in its own module so the codec wrappers can throw it without
// importing effects.js (which imports them).
export class CensorError extends Error {}
