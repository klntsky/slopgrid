import Database from "better-sqlite3";

// Shorten only the fixture connection's lock wait. SQLite still raises real
// BUSY errors and the application's persistence and cancellation code is used.
export function installFixtureDatabaseTiming() {
  const pragma = Database.prototype.pragma;
  const configured = new WeakSet<Database.Database>();
  Database.prototype.pragma = function (source, options) {
    if (!configured.has(this)) {
      configured.add(this);
      pragma.call(this, "busy_timeout = 25");
    }
    return pragma.call(this, source, options);
  };
  return () => {
    Database.prototype.pragma = pragma;
  };
}
