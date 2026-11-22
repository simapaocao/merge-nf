import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite';

/** Bun 1.3.14 caches only the first 20 distinct query() statements. Later statements normally
 * wait for GC, which can keep a supposedly closed SQLite file locked on Windows. Own every
 * application statement, finalize on eviction/close, then require sqlite3_close to succeed.
 * Queries here are short-lived; none are retained across async work or another DB operation.
 */
export class HubDatabase extends Database {
  private readonly statements = new Map<string,Statement>();
  override query<T, P extends SQLQueryBindings | SQLQueryBindings[]>(sql: string): Statement<T, P extends any[] ? P : [P]> {
    const cached = this.statements.get(sql);
    if (cached) { this.statements.delete(sql); this.statements.set(sql,cached); }
    else {
      if (this.statements.size >= 128) {
        const oldest = this.statements.keys().next().value!;
        this.statements.get(oldest)!.finalize(); this.statements.delete(oldest);
      }
      this.statements.set(sql,this.prepare(sql));
    }
    return this.statements.get(sql)! as Statement<T, P extends any[] ? P : [P]>;
  }
  override close(throwOnError = true): void {
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear(); super.close(throwOnError);
  }
}
