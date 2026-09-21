import assert from "node:assert/strict";
import test from "node:test";
import {
  createMysqlConnectionOptions
} from "./mysql-connection-options.js";

const databaseUrl = "mysql://app:secret@mysql.example:3306/shensi";

test("local MySQL connection stays unchanged when TLS is not configured", () => {
  assert.deepEqual(createMysqlConnectionOptions(databaseUrl, {}), {
    uri: databaseUrl,
    connectionLimit: 4,
    namedPlaceholders: true
  });
});

test("verified TLS uses the configured CA without weakening validation", () => {
  assert.deepEqual(createMysqlConnectionOptions(databaseUrl, {
    MYSQL_SSL_MODE: "verify_ca",
    MYSQL_SSL_CA: "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----"
  }), {
    uri: databaseUrl,
    connectionLimit: 4,
    namedPlaceholders: true,
    ssl: {
      ca: "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----",
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      verifyIdentity: true
    }
  });
});

test("verified TLS consumes Aiven ssl-mode instead of forwarding an unknown mysql2 option", () => {
  const aivenUrl = `${databaseUrl}?ssl-mode=REQUIRED`;
  const options = createMysqlConnectionOptions(aivenUrl, {
    MYSQL_SSL_MODE: "verify_ca",
    MYSQL_SSL_CA: "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----"
  });
  assert.equal(options.uri, databaseUrl);
});

test("verified TLS rejects missing or malformed CA configuration", () => {
  assert.throws(
    () => createMysqlConnectionOptions(databaseUrl, {
      MYSQL_SSL_MODE: "verify_ca"
    }),
    /MYSQL_SSL_CA/u
  );
  assert.throws(
    () => createMysqlConnectionOptions(databaseUrl, {
      MYSQL_SSL_MODE: "verify_ca",
      MYSQL_SSL_CA: "not-a-certificate"
    }),
    /MYSQL_SSL_CA/u
  );
});

test("unknown and insecure TLS modes fail closed", () => {
  for (const mode of ["required", "false", "prefer"]) {
    assert.throws(
      () => createMysqlConnectionOptions(databaseUrl, {
        MYSQL_SSL_MODE: mode
      }),
      /MYSQL_SSL_MODE/u
    );
  }
});
