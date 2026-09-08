import { describe, expect, it } from "vitest";
import {
  countLines, countStatements, detectDialect, formatSql, lineEndingOf, maskNoise, parseObjects,
} from "./sql";

describe("noise masking", () => {
  it("keeps every offset and newline so line numbers stay correct", () => {
    const text = "SELECT 1; -- hello\nSELECT 2;";
    const masked = maskNoise(text);
    expect(masked).toHaveLength(text.length);
    expect(masked.split("\n")).toHaveLength(2);
    expect(masked).toContain("SELECT 1;");
    expect(masked).not.toContain("hello");
  });

  it("blanks block comments, string literals and dollar-quoted bodies", () => {
    expect(maskNoise("/* CREATE TABLE a */")).not.toContain("CREATE");
    expect(maskNoise("SELECT 'CREATE TABLE a'")).not.toContain("CREATE");
    expect(maskNoise("AS $$ CREATE TABLE a $$")).not.toContain("CREATE");
    expect(maskNoise("AS $body$ CREATE TABLE a $body$")).not.toContain("CREATE");
  });

  it("treats a doubled quote as an escape rather than the end of the string", () => {
    expect(maskNoise("'it''s CREATE' TABLE")).toContain("TABLE");
    expect(maskNoise("'it''s CREATE' TABLE")).not.toContain("CREATE");
  });

  it("does not run past the end of an unterminated comment or string", () => {
    expect(() => maskNoise("/* never closed")).not.toThrow();
    expect(maskNoise("'never closed")).not.toContain("never");
  });
});

describe("object outline", () => {
  const script = `-- CREATE TABLE commented_out (id INT);
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE TYPE user_role AS ENUM ('admin');
CREATE TABLE app_users (
  id UUID PRIMARY KEY
);
CREATE UNIQUE INDEX idx_users_email ON app_users(email);
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
  -- CREATE TABLE not_real (x INT);
BEGIN RETURN NEW; END;
$$ LANGUAGE 'plpgsql';
CREATE TRIGGER trg_app_users_updated_at BEFORE UPDATE ON app_users;
`;

  it("lists what the script creates, in file order, with line numbers", () => {
    expect(parseObjects(script).map((object) => [object.kind, object.name, object.line])).toEqual([
      ["extension", "pgcrypto", 2],
      ["type", "user_role", 3],
      ["table", "app_users", 4],
      ["index", "idx_users_email", 7],
      ["function", "touch_updated_at", 8],
      ["trigger", "trg_app_users_updated_at", 12],
    ]);
  });

  it("ignores CREATE inside comments and function bodies", () => {
    const names = parseObjects(script).map((object) => object.name);
    expect(names).not.toContain("commented_out");
    expect(names).not.toContain("not_real");
  });

  it("handles IF NOT EXISTS, schema qualification and quoted identifiers", () => {
    expect(parseObjects('CREATE TABLE IF NOT EXISTS app.users (id INT);')[0].name).toBe("app.users");
    expect(parseObjects('CREATE TABLE "Odd Name" (id INT);')[0].name).toBe("Odd Name");
    expect(parseObjects("CREATE TABLE `back ticked` (id INT);")[0].name).toBe("back ticked");
    expect(parseObjects("CREATE TABLE [bracketed] (id INT);")[0].name).toBe("bracketed");
  });

  it("counts statements by semicolons outside strings and comments", () => {
    expect(countStatements("SELECT ';'; -- ;\nSELECT 2;")).toBe(2);
  });
});

describe("dialect detection", () => {
  it("names PostgreSQL from syntax only PostgreSQL accepts", () => {
    expect(detectDialect("CREATE FUNCTION f() AS $$ BEGIN END; $$ LANGUAGE 'plpgsql';")?.name).toBe("PostgreSQL");
    expect(detectDialect("SELECT metadata::jsonb FROM t;")?.name).toBe("PostgreSQL");
  });

  it("separates MySQL, SQLite and SQL Server", () => {
    expect(detectDialect("CREATE TABLE t (id INT AUTO_INCREMENT) ENGINE=InnoDB;")?.name).toBe("MySQL");
    expect(detectDialect("PRAGMA foreign_keys = ON;")?.name).toBe("SQLite");
    expect(detectDialect("CREATE TABLE [t] (name NVARCHAR(50));")?.name).toBe("SQL Server");
  });

  it("says nothing rather than guessing on portable SQL", () => {
    expect(detectDialect("CREATE TABLE t (id INT);")).toBeNull();
  });

  it("ignores markers that only appear inside a comment", () => {
    expect(detectDialect("-- AUTO_INCREMENT\nCREATE TABLE t (id INT);")).toBeNull();
  });

  it("reports which marker decided it, so the guess can be checked", () => {
    expect(detectDialect("PRAGMA foreign_keys = ON;")?.because).toBe("PRAGMA statement");
  });
});

describe("encoding facts", () => {
  it("names the line ending, and flags a mixed file", () => {
    expect(lineEndingOf("a\nb\n")).toBe("LF");
    expect(lineEndingOf("a\r\nb\r\n")).toBe("CRLF");
    expect(lineEndingOf("a\rb")).toBe("CR");
    expect(lineEndingOf("a\r\nb\n")).toBe("Mixed");
    expect(lineEndingOf("single line")).toBe("None");
  });

  it("counts lines the way an editor gutter does", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("one")).toBe(1);
    expect(countLines("one\ntwo")).toBe(2);
    expect(countLines("one\ntwo\n")).toBe(3);
  });
});

describe("formatting", () => {
  it("upper-cases reserved words and leaves identifiers alone", () => {
    expect(formatSql("select id from app_users where id is not null;"))
      .toBe("SELECT id FROM app_users WHERE id IS NOT NULL;");
  });

  it("never touches strings, comments or dollar-quoted bodies", () => {
    const text = "SELECT 'select from'; -- select from\n/* select */\nAS $$ select from $$";
    expect(formatSql(text)).toBe(text);
  });

  it("leaves a qualified name intact rather than upper-casing part of it", () => {
    expect(formatSql("select public.table from x;")).toBe("SELECT public.table FROM x;");
  });

  it("trims trailing whitespace and collapses runs of blank lines", () => {
    expect(formatSql("SELECT 1;   \n\n\n\nSELECT 2;")).toBe("SELECT 1;\n\nSELECT 2;");
  });

  it("is idempotent, so pressing Format twice changes nothing the second time", () => {
    const once = formatSql("select 1;\n\n\n\nselect 2;   ");
    expect(formatSql(once)).toBe(once);
  });
});
