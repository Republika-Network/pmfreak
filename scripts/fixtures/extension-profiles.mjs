// CERTIFIED EXTENSION PROFILES.
//
// name/version/schema is not provenance. PostgreSQL lets the owner of an extension attach
// an existing object to it WITHOUT changing the extension version, so a custom application
// object can acquire extension membership and disappear from every inventory that treats
// membership as platform provenance. A certified member can also be altered in place --
// gaining SECURITY DEFINER, say -- with its extension, version and membership untouched.
// Both were reproduced on a disposable scratch PostgreSQL 17 before this file existed.
//
// A profile therefore binds three things together, and a target must match ONE profile in
// FULL: the extension installation metadata, the COMPLETE membership graph (every
// pg_depend deptype 'e' edge, in whatever schema), and the exact structure of every member.
// Never a per-extension, per-member or per-field union across profiles.
//
// DIGEST. Canonical lines, stable-sorted, joined with one LF, no trailing LF, SHA-256 over
// the UTF-8 bytes, lowercase hex:
//
//   EXT|name|version|schema|owner|relocatable|config|condition
//   MEM|extname|classCatalog|objectType|schema|identity|owner|fingerprint
//
// extconfig is stored by oid, and oids are per-database, so `config` carries the RESOLVED
// identities instead. Member fingerprints are the same exact-byte structural hash the
// managed-object profiles use, over losslessly transported definitions.
//
// Version-controlled positive evidence. NEVER learned from the target under inspection:
// re-certifying is an explicit maintenance operation against a known-stock project.

import { createHash } from "node:crypto";

export const STOCK_EXTENSION_PROFILES = Object.freeze([
  Object.freeze({
    id: "local-cli-stock",
    source: "Supabase CLI local development stack (supabase start)",
    capturedAt: "2026-09-05",
    server: "PostgreSQL 17.6 on x86_64-pc-linux-gnu",
    cli: "v2.116.0",
    extensionCount: 5,
    memberCount: 70,
    byExtension: Object.freeze({"pg_stat_statements":9,"pgcrypto":36,"plpgsql":4,"supabase_vault":11,"uuid-ossp":10}),
    byClass: Object.freeze({"pg_class":4,"pg_language":1,"pg_proc":57,"pg_type":8}),
    digest: "18d8850fc8f40d768789279aec36ae2962af8bb03b6fa60bbd108cb5e28f6680",
    extensions: Object.freeze([
      { extname: "pg_stat_statements", extversion: "1.11", schema: "extensions", owner: "supabase_admin", relocatable: "true", config: "(none)", condition: "(none)" },
      { extname: "pgcrypto", extversion: "1.3", schema: "extensions", owner: "supabase_admin", relocatable: "true", config: "(none)", condition: "(none)" },
      { extname: "plpgsql", extversion: "1.0", schema: "pg_catalog", owner: "supabase_admin", relocatable: "false", config: "(none)", condition: "(none)" },
      { extname: "supabase_vault", extversion: "0.3.1", schema: "vault", owner: "supabase_admin", relocatable: "false", config: "vault.secrets", condition: "" },
      { extname: "uuid-ossp", extversion: "1.1", schema: "extensions", owner: "supabase_admin", relocatable: "true", config: "(none)", condition: "(none)" },
    ]),
    members: Object.freeze([
      { extname: "pg_stat_statements", classCatalog: "pg_class", objectType: "view", schema: "extensions", identity: "extensions.pg_stat_statements", owner: "supabase_admin", fingerprint: "aefa374fdb94e6536342ba7d" },
      { extname: "pg_stat_statements", classCatalog: "pg_class", objectType: "view", schema: "extensions", identity: "extensions.pg_stat_statements_info", owner: "supabase_admin", fingerprint: "377a3392bac2e5ee109b3fb1" },
      { extname: "pg_stat_statements", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pg_stat_statements(boolean)", owner: "supabase_admin", fingerprint: "2a56892de2eb80df5cdd0aa9" },
      { extname: "pg_stat_statements", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pg_stat_statements_info()", owner: "supabase_admin", fingerprint: "5b531400f0714bebe105ceee" },
      { extname: "pg_stat_statements", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pg_stat_statements_reset(pg_catalog.oid,pg_catalog.oid,bigint,boolean)", owner: "supabase_admin", fingerprint: "c1238351ab184cc48103c200" },
      { extname: "pg_stat_statements", classCatalog: "pg_type", objectType: "type", schema: "extensions", identity: "extensions.pg_stat_statements", owner: "supabase_admin", fingerprint: "4a3fd6367fab84ff823e5dfa" },
      { extname: "pg_stat_statements", classCatalog: "pg_type", objectType: "type", schema: "extensions", identity: "extensions.pg_stat_statements[]", owner: "supabase_admin", fingerprint: "57870883e8a15b6ae8693a04" },
      { extname: "pg_stat_statements", classCatalog: "pg_type", objectType: "type", schema: "extensions", identity: "extensions.pg_stat_statements_info", owner: "supabase_admin", fingerprint: "40903fc7f4b27869a2df6f75" },
      { extname: "pg_stat_statements", classCatalog: "pg_type", objectType: "type", schema: "extensions", identity: "extensions.pg_stat_statements_info[]", owner: "supabase_admin", fingerprint: "57870883e8a15b6ae8693a04" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.armor(pg_catalog.bytea)", owner: "supabase_admin", fingerprint: "9f62935f010fa01a5e1f753d" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.armor(pg_catalog.bytea,pg_catalog.text[],pg_catalog.text[])", owner: "supabase_admin", fingerprint: "ac2de345cff84439f0e17cad" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.crypt(pg_catalog.text,pg_catalog.text)", owner: "supabase_admin", fingerprint: "4765b2136474542e65298022" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.dearmor(pg_catalog.text)", owner: "supabase_admin", fingerprint: "9f60d5f246063e18a7b46ae9" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.decrypt(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text)", owner: "supabase_admin", fingerprint: "241c3ee08ad40a291ec8d4c9" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.decrypt_iv(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text)", owner: "supabase_admin", fingerprint: "2e7efe19a45a9d633df0f804" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.digest(pg_catalog.bytea,pg_catalog.text)", owner: "supabase_admin", fingerprint: "b1a5ce902829f1e5e367e81a" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.digest(pg_catalog.text,pg_catalog.text)", owner: "supabase_admin", fingerprint: "14ac0c131dd37899085212b6" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.encrypt(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text)", owner: "supabase_admin", fingerprint: "5348603cb95202966f5a50a6" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.encrypt_iv(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text)", owner: "supabase_admin", fingerprint: "abb16ef1b8c3701fb95aedad" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.gen_random_bytes(integer)", owner: "supabase_admin", fingerprint: "225c413521584a2791bd4f03" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.gen_random_uuid()", owner: "supabase_admin", fingerprint: "dc6df8e0963261a540f35aee" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.gen_salt(pg_catalog.text)", owner: "supabase_admin", fingerprint: "68c6a9584e7fc49c4c56ffaf" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.gen_salt(pg_catalog.text,integer)", owner: "supabase_admin", fingerprint: "3cad638c0d656de78075dea1" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.hmac(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text)", owner: "supabase_admin", fingerprint: "1cff9b0e369ac70613623b0b" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.hmac(pg_catalog.text,pg_catalog.text,pg_catalog.text)", owner: "supabase_admin", fingerprint: "0fee13e4145a37203af0dd65" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_armor_headers(pg_catalog.text)", owner: "supabase_admin", fingerprint: "23ce2627221707fb6bbcef4b" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_key_id(pg_catalog.bytea)", owner: "supabase_admin", fingerprint: "9b009df8e7889317123a7378" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_decrypt(pg_catalog.bytea,pg_catalog.bytea)", owner: "supabase_admin", fingerprint: "da337ff8322c0be8ee870836" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_decrypt(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text)", owner: "supabase_admin", fingerprint: "830cfc61455e481ce728a65b" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_decrypt(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text,pg_catalog.text)", owner: "supabase_admin", fingerprint: "a024e7f70788044737d1d24d" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_decrypt_bytea(pg_catalog.bytea,pg_catalog.bytea)", owner: "supabase_admin", fingerprint: "ca327df175405f18d4a5fd85" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_decrypt_bytea(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text)", owner: "supabase_admin", fingerprint: "70561aa0dd9eecd0a4e2183a" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_decrypt_bytea(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text,pg_catalog.text)", owner: "supabase_admin", fingerprint: "c81b4f27cf274f8518db00d1" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_encrypt(pg_catalog.text,pg_catalog.bytea)", owner: "supabase_admin", fingerprint: "fc1a036dae32181ba4914059" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_encrypt(pg_catalog.text,pg_catalog.bytea,pg_catalog.text)", owner: "supabase_admin", fingerprint: "1e534c4db083e8f6d5f1b60e" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_encrypt_bytea(pg_catalog.bytea,pg_catalog.bytea)", owner: "supabase_admin", fingerprint: "233e179777c203942dd5e0da" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_encrypt_bytea(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text)", owner: "supabase_admin", fingerprint: "58d6963cfda533cb61a125ce" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_sym_decrypt(pg_catalog.bytea,pg_catalog.text)", owner: "supabase_admin", fingerprint: "680940c0ebfd458379b8cff6" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_sym_decrypt(pg_catalog.bytea,pg_catalog.text,pg_catalog.text)", owner: "supabase_admin", fingerprint: "4b976fc1cd8a8b8dfd490411" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_sym_decrypt_bytea(pg_catalog.bytea,pg_catalog.text)", owner: "supabase_admin", fingerprint: "5d28fcf74f9a2eb531ece65c" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_sym_decrypt_bytea(pg_catalog.bytea,pg_catalog.text,pg_catalog.text)", owner: "supabase_admin", fingerprint: "26727b11b5fa4bf221b3d9a3" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_sym_encrypt(pg_catalog.text,pg_catalog.text)", owner: "supabase_admin", fingerprint: "5aa7257d61900e419a6a26f4" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_sym_encrypt(pg_catalog.text,pg_catalog.text,pg_catalog.text)", owner: "supabase_admin", fingerprint: "658dd1e191c6850fa403943d" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_sym_encrypt_bytea(pg_catalog.bytea,pg_catalog.text)", owner: "supabase_admin", fingerprint: "bbee6f9161dfb46f67aa17f5" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_sym_encrypt_bytea(pg_catalog.bytea,pg_catalog.text,pg_catalog.text)", owner: "supabase_admin", fingerprint: "7187eafb2f212065ac1d78ae" },
      { extname: "plpgsql", classCatalog: "pg_language", objectType: "language", schema: "", identity: "plpgsql", owner: "supabase_admin", fingerprint: "e54ac06a5bf9996ea846babe" },
      { extname: "plpgsql", classCatalog: "pg_proc", objectType: "function", schema: "pg_catalog", identity: "pg_catalog.plpgsql_call_handler()", owner: "supabase_admin", fingerprint: "2a320f00fd36c5f272ff1dd2" },
      { extname: "plpgsql", classCatalog: "pg_proc", objectType: "function", schema: "pg_catalog", identity: "pg_catalog.plpgsql_inline_handler(pg_catalog.internal)", owner: "supabase_admin", fingerprint: "196ce0198ca93f61b5e02641" },
      { extname: "plpgsql", classCatalog: "pg_proc", objectType: "function", schema: "pg_catalog", identity: "pg_catalog.plpgsql_validator(pg_catalog.oid)", owner: "supabase_admin", fingerprint: "ba596c6a0a44da3c8ddb9aa3" },
      { extname: "supabase_vault", classCatalog: "pg_class", objectType: "table", schema: "vault", identity: "vault.secrets", owner: "supabase_admin", fingerprint: "d20760cc15cc0927157a5f08" },
      { extname: "supabase_vault", classCatalog: "pg_class", objectType: "view", schema: "vault", identity: "vault.decrypted_secrets", owner: "supabase_admin", fingerprint: "d66a67acea7e958d06625b64" },
      { extname: "supabase_vault", classCatalog: "pg_proc", objectType: "function", schema: "vault", identity: "vault._crypto_aead_det_decrypt(pg_catalog.bytea,pg_catalog.bytea,bigint,pg_catalog.bytea,pg_catalog.bytea)", owner: "supabase_admin", fingerprint: "a8d9a9ff47c0f450c01efbf9" },
      { extname: "supabase_vault", classCatalog: "pg_proc", objectType: "function", schema: "vault", identity: "vault._crypto_aead_det_encrypt(pg_catalog.bytea,pg_catalog.bytea,bigint,pg_catalog.bytea,pg_catalog.bytea)", owner: "supabase_admin", fingerprint: "bd548f15658c0845c90fe81b" },
      { extname: "supabase_vault", classCatalog: "pg_proc", objectType: "function", schema: "vault", identity: "vault._crypto_aead_det_noncegen()", owner: "supabase_admin", fingerprint: "d1eb6e487077d8e754fd2563" },
      { extname: "supabase_vault", classCatalog: "pg_proc", objectType: "function", schema: "vault", identity: "vault.create_secret(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid)", owner: "supabase_admin", fingerprint: "3bd3507fd36eee32cfd2179c" },
      { extname: "supabase_vault", classCatalog: "pg_proc", objectType: "function", schema: "vault", identity: "vault.update_secret(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid)", owner: "supabase_admin", fingerprint: "f5c4cf671f089770d84363f5" },
      { extname: "supabase_vault", classCatalog: "pg_type", objectType: "type", schema: "vault", identity: "vault.decrypted_secrets", owner: "supabase_admin", fingerprint: "e4de4ffef87100e399991570" },
      { extname: "supabase_vault", classCatalog: "pg_type", objectType: "type", schema: "vault", identity: "vault.decrypted_secrets[]", owner: "supabase_admin", fingerprint: "57870883e8a15b6ae8693a04" },
      { extname: "supabase_vault", classCatalog: "pg_type", objectType: "type", schema: "vault", identity: "vault.secrets", owner: "supabase_admin", fingerprint: "1c2d13a200afbe8f259c83cb" },
      { extname: "supabase_vault", classCatalog: "pg_type", objectType: "type", schema: "vault", identity: "vault.secrets[]", owner: "supabase_admin", fingerprint: "57870883e8a15b6ae8693a04" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_generate_v1()", owner: "supabase_admin", fingerprint: "7b5de54c226255b215651e22" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_generate_v1mc()", owner: "supabase_admin", fingerprint: "f3ae803b46240f4006f70c3a" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_generate_v3(pg_catalog.uuid,pg_catalog.text)", owner: "supabase_admin", fingerprint: "624c183d7a08162d297c0821" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_generate_v4()", owner: "supabase_admin", fingerprint: "18dba412dfb97f629d531ea5" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_generate_v5(pg_catalog.uuid,pg_catalog.text)", owner: "supabase_admin", fingerprint: "26b081e72973ee2a8150d86b" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_nil()", owner: "supabase_admin", fingerprint: "160462fad63af3d7730254ac" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_ns_dns()", owner: "supabase_admin", fingerprint: "82be89935035ccc44712acdd" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_ns_oid()", owner: "supabase_admin", fingerprint: "6765e60bad3724d645cb1add" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_ns_url()", owner: "supabase_admin", fingerprint: "38b1cd0fc19aa4cff53e80e7" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_ns_x500()", owner: "supabase_admin", fingerprint: "c5ed0e7dbf8dc29ebd6a8bf6" },
    ]),
  }),
  Object.freeze({
    id: "hosted-platform-stock",
    source: "hosted Supabase validation project (independent read-only capture)",
    capturedAt: "2026-09-05",
    server: "PostgreSQL 17.6 (hosted platform image 17.6.1.141)",
    cli: null,
    extensionCount: 5,
    memberCount: 70,
    byExtension: Object.freeze({"pg_stat_statements":9,"pgcrypto":36,"plpgsql":4,"supabase_vault":11,"uuid-ossp":10}),
    byClass: Object.freeze({"pg_class":4,"pg_language":1,"pg_proc":57,"pg_type":8}),
    digest: "77142f7c83f5f2b6d2f8b3c07e530a22a001354ab7204b9826357c801e9d68bd",
    extensions: Object.freeze([
      { extname: "pg_stat_statements", extversion: "1.11", schema: "extensions", owner: "postgres", relocatable: "true", config: "(none)", condition: "(none)" },
      { extname: "pgcrypto", extversion: "1.3", schema: "extensions", owner: "postgres", relocatable: "true", config: "(none)", condition: "(none)" },
      { extname: "plpgsql", extversion: "1.0", schema: "pg_catalog", owner: "supabase_admin", relocatable: "false", config: "(none)", condition: "(none)" },
      { extname: "supabase_vault", extversion: "0.3.1", schema: "vault", owner: "supabase_admin", relocatable: "false", config: "vault.secrets", condition: "" },
      { extname: "uuid-ossp", extversion: "1.1", schema: "extensions", owner: "postgres", relocatable: "true", config: "(none)", condition: "(none)" },
    ]),
    members: Object.freeze([
      { extname: "pg_stat_statements", classCatalog: "pg_class", objectType: "view", schema: "extensions", identity: "extensions.pg_stat_statements", owner: "postgres", fingerprint: "8048bc152279dd4c10b5a2e9" },
      { extname: "pg_stat_statements", classCatalog: "pg_class", objectType: "view", schema: "extensions", identity: "extensions.pg_stat_statements_info", owner: "postgres", fingerprint: "75a20c6187d6c6433ee1d195" },
      { extname: "pg_stat_statements", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pg_stat_statements(boolean)", owner: "postgres", fingerprint: "721422c0af7e434f6663c670" },
      { extname: "pg_stat_statements", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pg_stat_statements_info()", owner: "postgres", fingerprint: "98c6c003fc567f4713af0a78" },
      { extname: "pg_stat_statements", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pg_stat_statements_reset(pg_catalog.oid,pg_catalog.oid,bigint,boolean)", owner: "postgres", fingerprint: "2342b2e052eeb77d172192ea" },
      { extname: "pg_stat_statements", classCatalog: "pg_type", objectType: "type", schema: "extensions", identity: "extensions.pg_stat_statements", owner: "postgres", fingerprint: "4a3fd6367fab84ff823e5dfa" },
      { extname: "pg_stat_statements", classCatalog: "pg_type", objectType: "type", schema: "extensions", identity: "extensions.pg_stat_statements[]", owner: "postgres", fingerprint: "57870883e8a15b6ae8693a04" },
      { extname: "pg_stat_statements", classCatalog: "pg_type", objectType: "type", schema: "extensions", identity: "extensions.pg_stat_statements_info", owner: "postgres", fingerprint: "40903fc7f4b27869a2df6f75" },
      { extname: "pg_stat_statements", classCatalog: "pg_type", objectType: "type", schema: "extensions", identity: "extensions.pg_stat_statements_info[]", owner: "postgres", fingerprint: "57870883e8a15b6ae8693a04" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.armor(pg_catalog.bytea)", owner: "postgres", fingerprint: "12d3d07be43542e800070957" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.armor(pg_catalog.bytea,pg_catalog.text[],pg_catalog.text[])", owner: "postgres", fingerprint: "53054b19259f1b88f674ad47" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.crypt(pg_catalog.text,pg_catalog.text)", owner: "postgres", fingerprint: "27deb4cc0e07db25aee1e9db" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.dearmor(pg_catalog.text)", owner: "postgres", fingerprint: "76a6d4a52a8f394075a3fda7" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.decrypt(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text)", owner: "postgres", fingerprint: "4e8e52b2acfdf9dd1168a356" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.decrypt_iv(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text)", owner: "postgres", fingerprint: "cf19bd2f49139f1aaf66ad57" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.digest(pg_catalog.bytea,pg_catalog.text)", owner: "postgres", fingerprint: "3d39579c2911c18abea7b9ae" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.digest(pg_catalog.text,pg_catalog.text)", owner: "postgres", fingerprint: "9bbb8013c25e9b3ac37eed42" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.encrypt(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text)", owner: "postgres", fingerprint: "f26ccf440373714697e21848" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.encrypt_iv(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text)", owner: "postgres", fingerprint: "ee49e28613de5272b720616b" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.gen_random_bytes(integer)", owner: "postgres", fingerprint: "564d11556dd2f32198aa7b35" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.gen_random_uuid()", owner: "postgres", fingerprint: "f944078eaadc3be55e501b02" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.gen_salt(pg_catalog.text)", owner: "postgres", fingerprint: "cd33013583bef6b6be1b7209" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.gen_salt(pg_catalog.text,integer)", owner: "postgres", fingerprint: "6279314100d3e705f24a825a" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.hmac(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text)", owner: "postgres", fingerprint: "5bf49707abe3663ba9d56179" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.hmac(pg_catalog.text,pg_catalog.text,pg_catalog.text)", owner: "postgres", fingerprint: "ddf620c16e0396b8ea2c75a4" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_armor_headers(pg_catalog.text)", owner: "postgres", fingerprint: "3c2054b24bff1fd07c90b298" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_key_id(pg_catalog.bytea)", owner: "postgres", fingerprint: "e43c9e2bb1965b8b55b8ac39" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_decrypt(pg_catalog.bytea,pg_catalog.bytea)", owner: "postgres", fingerprint: "46c4af6e5c54bc41ab8762c7" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_decrypt(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text)", owner: "postgres", fingerprint: "505eacf9b0dff9ceb5af7579" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_decrypt(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text,pg_catalog.text)", owner: "postgres", fingerprint: "758613a60dd72ff2378402ea" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_decrypt_bytea(pg_catalog.bytea,pg_catalog.bytea)", owner: "postgres", fingerprint: "43654e0372c3434a2209805f" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_decrypt_bytea(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text)", owner: "postgres", fingerprint: "b9a9b6f085aadf267850bbad" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_decrypt_bytea(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text,pg_catalog.text)", owner: "postgres", fingerprint: "eaa121f5ddbf444e4d2f88ac" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_encrypt(pg_catalog.text,pg_catalog.bytea)", owner: "postgres", fingerprint: "2342b786ef4555154f78374c" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_encrypt(pg_catalog.text,pg_catalog.bytea,pg_catalog.text)", owner: "postgres", fingerprint: "b508b46dc09316d30e790d99" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_encrypt_bytea(pg_catalog.bytea,pg_catalog.bytea)", owner: "postgres", fingerprint: "0c4f4959e7e73ba224e5f91e" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_pub_encrypt_bytea(pg_catalog.bytea,pg_catalog.bytea,pg_catalog.text)", owner: "postgres", fingerprint: "366f02f7696bbdb0fc6532fd" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_sym_decrypt(pg_catalog.bytea,pg_catalog.text)", owner: "postgres", fingerprint: "71e8dafd31f2342206d102e0" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_sym_decrypt(pg_catalog.bytea,pg_catalog.text,pg_catalog.text)", owner: "postgres", fingerprint: "17741b054c3ddbfb70ad5048" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_sym_decrypt_bytea(pg_catalog.bytea,pg_catalog.text)", owner: "postgres", fingerprint: "fa8ab1bf0fc226da5042ee57" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_sym_decrypt_bytea(pg_catalog.bytea,pg_catalog.text,pg_catalog.text)", owner: "postgres", fingerprint: "83f69b590e8513704d8e633f" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_sym_encrypt(pg_catalog.text,pg_catalog.text)", owner: "postgres", fingerprint: "231cba4fd64942b3699fd4fa" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_sym_encrypt(pg_catalog.text,pg_catalog.text,pg_catalog.text)", owner: "postgres", fingerprint: "69316bdfa30e665c349d935e" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_sym_encrypt_bytea(pg_catalog.bytea,pg_catalog.text)", owner: "postgres", fingerprint: "651ba70863af9961486d1343" },
      { extname: "pgcrypto", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.pgp_sym_encrypt_bytea(pg_catalog.bytea,pg_catalog.text,pg_catalog.text)", owner: "postgres", fingerprint: "49ff1b688051164611753bd1" },
      { extname: "plpgsql", classCatalog: "pg_language", objectType: "language", schema: "", identity: "plpgsql", owner: "supabase_admin", fingerprint: "e54ac06a5bf9996ea846babe" },
      { extname: "plpgsql", classCatalog: "pg_proc", objectType: "function", schema: "pg_catalog", identity: "pg_catalog.plpgsql_call_handler()", owner: "supabase_admin", fingerprint: "2a320f00fd36c5f272ff1dd2" },
      { extname: "plpgsql", classCatalog: "pg_proc", objectType: "function", schema: "pg_catalog", identity: "pg_catalog.plpgsql_inline_handler(pg_catalog.internal)", owner: "supabase_admin", fingerprint: "196ce0198ca93f61b5e02641" },
      { extname: "plpgsql", classCatalog: "pg_proc", objectType: "function", schema: "pg_catalog", identity: "pg_catalog.plpgsql_validator(pg_catalog.oid)", owner: "supabase_admin", fingerprint: "ba596c6a0a44da3c8ddb9aa3" },
      { extname: "supabase_vault", classCatalog: "pg_class", objectType: "table", schema: "vault", identity: "vault.secrets", owner: "supabase_admin", fingerprint: "d20760cc15cc0927157a5f08" },
      { extname: "supabase_vault", classCatalog: "pg_class", objectType: "view", schema: "vault", identity: "vault.decrypted_secrets", owner: "supabase_admin", fingerprint: "d66a67acea7e958d06625b64" },
      { extname: "supabase_vault", classCatalog: "pg_proc", objectType: "function", schema: "vault", identity: "vault._crypto_aead_det_decrypt(pg_catalog.bytea,pg_catalog.bytea,bigint,pg_catalog.bytea,pg_catalog.bytea)", owner: "supabase_admin", fingerprint: "a8d9a9ff47c0f450c01efbf9" },
      { extname: "supabase_vault", classCatalog: "pg_proc", objectType: "function", schema: "vault", identity: "vault._crypto_aead_det_encrypt(pg_catalog.bytea,pg_catalog.bytea,bigint,pg_catalog.bytea,pg_catalog.bytea)", owner: "supabase_admin", fingerprint: "bd548f15658c0845c90fe81b" },
      { extname: "supabase_vault", classCatalog: "pg_proc", objectType: "function", schema: "vault", identity: "vault._crypto_aead_det_noncegen()", owner: "supabase_admin", fingerprint: "d1eb6e487077d8e754fd2563" },
      { extname: "supabase_vault", classCatalog: "pg_proc", objectType: "function", schema: "vault", identity: "vault.create_secret(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid)", owner: "supabase_admin", fingerprint: "3bd3507fd36eee32cfd2179c" },
      { extname: "supabase_vault", classCatalog: "pg_proc", objectType: "function", schema: "vault", identity: "vault.update_secret(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid)", owner: "supabase_admin", fingerprint: "f5c4cf671f089770d84363f5" },
      { extname: "supabase_vault", classCatalog: "pg_type", objectType: "type", schema: "vault", identity: "vault.decrypted_secrets", owner: "supabase_admin", fingerprint: "e4de4ffef87100e399991570" },
      { extname: "supabase_vault", classCatalog: "pg_type", objectType: "type", schema: "vault", identity: "vault.decrypted_secrets[]", owner: "supabase_admin", fingerprint: "57870883e8a15b6ae8693a04" },
      { extname: "supabase_vault", classCatalog: "pg_type", objectType: "type", schema: "vault", identity: "vault.secrets", owner: "supabase_admin", fingerprint: "1c2d13a200afbe8f259c83cb" },
      { extname: "supabase_vault", classCatalog: "pg_type", objectType: "type", schema: "vault", identity: "vault.secrets[]", owner: "supabase_admin", fingerprint: "57870883e8a15b6ae8693a04" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_generate_v1()", owner: "postgres", fingerprint: "2aa5ed9c003ec4fb0f7cdc54" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_generate_v1mc()", owner: "postgres", fingerprint: "d7a8ca9b75607e7295e0e983" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_generate_v3(pg_catalog.uuid,pg_catalog.text)", owner: "postgres", fingerprint: "7a14e190d3c72137e7c548e9" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_generate_v4()", owner: "postgres", fingerprint: "17a022538c5d53bca0fb72c4" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_generate_v5(pg_catalog.uuid,pg_catalog.text)", owner: "postgres", fingerprint: "01081dfc9386832bbb8b4c60" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_nil()", owner: "postgres", fingerprint: "bc1208f7c0c26a99d16c5bdc" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_ns_dns()", owner: "postgres", fingerprint: "053cc3cc1ef6c582925d1645" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_ns_oid()", owner: "postgres", fingerprint: "e57a21d7a903d8704c21c1b8" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_ns_url()", owner: "postgres", fingerprint: "1857dff555f8e452fb406162" },
      { extname: "uuid-ossp", classCatalog: "pg_proc", objectType: "function", schema: "extensions", identity: "extensions.uuid_ns_x500()", owner: "postgres", fingerprint: "fc21ad145b690fd201744870" },
    ]),
  }),
]);

// FAIL CLOSED AT LOAD. A profile is only evidence while it is the evidence that was
// certified, so a hand-edited entry throws before anything can be certified against it.
for (const profile of STOCK_EXTENSION_PROFILES) {
  if (profile.extensions.length !== profile.extensionCount || profile.members.length !== profile.memberCount) {
    throw new Error(`certified extension profile ${profile.id} miscounts its own contents`);
  }
  const lines = [
    ...profile.extensions.map((e) => `EXT|${e.extname}|${e.extversion}|${e.schema}|${e.owner}|${e.relocatable}|${e.config}|${e.condition}`),
    ...profile.members.map((m) => `MEM|${m.extname}|${m.classCatalog}|${m.objectType}|${m.schema}|${m.identity}|${m.owner}|${m.fingerprint}`),
  ];
  if (new Set(lines).size !== lines.length) {
    throw new Error(`certified extension profile ${profile.id} carries a duplicate record`);
  }
  const digest = createHash("sha256").update([...lines].sort().join("\n"), "utf8").digest("hex");
  if (digest !== profile.digest) {
    throw new Error(
      `certified extension profile ${profile.id} does not match its certified digest (computed ${digest}, expected ${profile.digest}). ` +
      "Re-certify it from a known-stock capture; do not adjust the digest to match an edit.",
    );
  }
}
