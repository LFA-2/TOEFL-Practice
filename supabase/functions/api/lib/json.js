// Marks a value that must be stored as jsonb. The driver encodes it exactly once.
// Passing JSON.stringify(...) instead stores a JSON string, which later reads as a string, not an object.
export class Json {
  constructor(value) { this.value = value; }
}
export const json = value => new Json(value);
