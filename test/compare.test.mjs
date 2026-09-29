import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { capInfo, primitiveOf } from "../src/caps.mjs";
import { compare } from "../src/compare.mjs";
import { inventory } from "../src/inventory.mjs";
import { readFolder } from "../src/sources.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.join(here, "..", "examples");

/** Compares two versions given as { "file.php": code }. */
function diff(before, after) {
  const files = (map) => Object.entries(map).map(([p, code]) => ({ path: p, code }));
  return compare(inventory(files(before)).entries, inventory(files(after)).entries);
}
const codes = (findings) => findings.map((f) => `${f.code}:${f.key}`);
const ajax = (body, extra = "") => `<?php\nadd_action( 'wp_ajax_acme_go', 'acme_go' );\n${extra}\nfunction acme_go() {\n${body}\n}\n`;

test("the example plugin: every change it was written to show is found, with its severity", () => {
  const base = inventory(readFolder(path.join(examples, "before")));
  const head = inventory(readFolder(path.join(examples, "after")));
  assert.equal(base.entries.size, 13);
  assert.equal(head.entries.size, 14);
  const found = Object.fromEntries(compare(base.entries, head.entries).map((f) => [f.key, `${f.severity}:${f.code}`]));
  assert.deepEqual(found, {
    "admin-post:example_reset": "wider:nonce-removed",
    "ajax-nopriv:example_subscribe": "wider:now-public",
    "ajax:example_export": "wider:capability-lowered",
    "ajax:example_save_settings": "wider:check-after-write",
    "ajax:example_update_note": "wider:object-dropped",
    "menu:example-reports": "wider:capability-lowered",
    "rest:GET example/v1/stats": "wider:capability-lowered",
    "rest:PATCH,POST,PUT example/v1/settings": "wider:check-removed",
    "ajax:example_clear_log": "warning:capability-changed",
    "ajax:example_dismiss": "warning:condition-changed",
    "ajax:example_import": "warning:new-unchecked",
    "ajax:example_legacy_sync": "info:removed",
  });
});

test("unchanged operations produce nothing", () => {
  const base = inventory(readFolder(path.join(examples, "before")));
  assert.deepEqual(compare(base.entries, base.entries), []);
});

test("callbacks are followed through methods, helpers, closures and namespaced strings", () => {
  const { entries } = inventory([
    {
      path: "a.php",
      code: `<?php
namespace Acme;
class Admin {
  public function __construct() {
    add_action( 'wp_ajax_acme_method', array( $this, 'run' ) );
    add_action( 'wp_ajax_acme_static', array( __CLASS__, 'run_static' ) );
    add_action( 'wp_ajax_acme_string', 'Acme\\\\Admin::run_static' );
    add_action( 'wp_ajax_acme_closure', function () { check_ajax_referer( 'x' ); if ( ! current_user_can( 'edit_posts' ) ) { die; } } );
    add_action( 'wp_ajax_acme_fn', __NAMESPACE__ . '\\go' );
  }
  public function run() { $this->guard(); update_option( 'a', 1 ); }
  private function guard() { if ( ! current_user_can( 'manage_options' ) ) { wp_die(); } }
  public static function run_static() { self::guard_static(); }
  private static function guard_static() { current_user_can( 'upload_files' ) || wp_die(); }
}
function go() { helper(); }
function helper() { return current_user_can( 'publish_posts' ); }
`,
    },
  ]);
  const rank = (key) => entries.get(key).gate.rank;
  assert.equal(rank("ajax:acme_method"), 4);
  assert.equal(entries.get("ajax:acme_method").gate.firstCheck < entries.get("ajax:acme_method").gate.firstWrite, true);
  assert.equal(rank("ajax:acme_static"), 2);
  assert.equal(rank("ajax:acme_string"), 2);
  assert.equal(rank("ajax:acme_closure"), 1);
  assert.equal(entries.get("ajax:acme_closure").gate.nonces.length, 1);
  assert.equal(rank("ajax:acme_fn"), 2);
});

test("an object in a variable is followed only when one class has that method", () => {
  const code = (extra) => `<?php
class One { public function handle() { current_user_can( 'manage_options' ); } }
${extra}
$one = new One();
add_action( 'wp_ajax_acme', array( $one, 'handle' ) );
`;
  assert.equal(inventory([{ path: "a.php", code: code("") }]).entries.get("ajax:acme").gate.rank, 4);
  const ambiguous = inventory([{ path: "a.php", code: code("class Two { public function handle() {} }") }]).entries.get("ajax:acme");
  assert.equal(ambiguous.gate.resolved, false);
  assert.equal(ambiguous.gate.rank, null);
});

test("an unresolved callback is never compared", () => {
  const before = ajax("current_user_can( 'manage_options' );");
  const after = "<?php\nadd_action( 'wp_ajax_acme_go', $callback );\n";
  assert.deepEqual(diff({ "a.php": before }, { "a.php": after }), []);
});

test("removing the only check, from an action for logged-in users", () => {
  const found = diff({ "a.php": ajax("if ( ! current_user_can( 'manage_options' ) ) { wp_die(); }\nupdate_option( 'x', 1 );") }, { "a.php": ajax("update_option( 'x', 1 );") });
  assert.deepEqual(codes(found), ["check-removed:ajax:acme_go"]);
  assert.match(found[0].message, /any logged-in user can run it/);
});

test("user_can, has_cap and current_user_can_for_site read the capability from the right argument", () => {
  const rankOf = (body) => inventory([{ path: "a.php", code: ajax(body) }]).entries.get("ajax:acme_go").gate.rank;
  assert.equal(rankOf("user_can( $user, 'edit_users' );"), 4);
  assert.equal(rankOf("wp_get_current_user()->has_cap( 'moderate_comments' );"), 3);
  assert.equal(rankOf("current_user_can_for_site( 2, 'publish_posts' );"), 2);
  assert.equal(rankOf("is_super_admin();"), 5);
});

test("a capability the tool cannot rank makes a change a warning, not a verdict", () => {
  const found = diff({ "a.php": ajax("current_user_can( 'manage_options' );") }, { "a.php": ajax("current_user_can( 'manage_acme' );") });
  assert.deepEqual(codes(found), ["capability-changed:ajax:acme_go"]);
  assert.equal(found[0].severity, "warning");
});

test("a raised or same-rank capability is information", () => {
  assert.deepEqual(codes(diff({ "a.php": ajax("current_user_can( 'edit_posts' );") }, { "a.php": ajax("current_user_can( 'manage_options' );") })), [
    "capability-raised:ajax:acme_go",
  ]);
  const swapped = diff({ "a.php": ajax("current_user_can( 'edit_posts' );") }, { "a.php": ajax("current_user_can( 'delete_posts' );") });
  assert.deepEqual(codes(swapped), ["capability-swapped:ajax:acme_go"]);
  assert.match(swapped[0].message, /it still needs contributor/);
});

test("dropping is_user_logged_in beside a stronger check changes nothing that matters", () => {
  const found = diff(
    { "a.php": ajax("if ( ! is_user_logged_in() || ! current_user_can( 'manage_options' ) ) { wp_die(); }") },
    { "a.php": ajax("if ( ! current_user_can( 'manage_options' ) ) { wp_die(); }") },
  );
  assert.deepEqual(codes(found), ["capability-swapped:ajax:acme_go"]);
});

test("a meta capability's object: dropped is wider, changed is a warning, a stronger primitive is information", () => {
  const before = ajax("current_user_can( 'edit_post', $id );");
  // A different expression for the object may check a different post: someone has to look.
  assert.deepEqual(codes(diff({ "a.php": before }, { "a.php": before.replace("$id", "$post->ID") })), ["condition-changed:ajax:acme_go"]);
  assert.deepEqual(codes(diff({ "a.php": before }, { "a.php": ajax("current_user_can( 'edit_post' );") })), ["object-dropped:ajax:acme_go"]);
  assert.deepEqual(codes(diff({ "a.php": before }, { "a.php": ajax("current_user_can( 'edit_others_posts' );") })), ["capability-raised:ajax:acme_go"]);
});

test("whitespace inside a condition is not a change; more checks under new conditions are information", () => {
  const before = ajax("if ( ! wp_verify_nonce( $n, 'a-'.$t ) && current_user_can( 'edit_posts' ) ) { die; }");
  assert.deepEqual(diff({ "a.php": before }, { "a.php": before.replace("'a-'.$t", "'a-' . $t") }), []);
  const more = ajax("if ( ! wp_verify_nonce( $n, 'a-'.$t ) && current_user_can( 'edit_posts' ) ) { die; }\nif ( $id && ! current_user_can( 'edit_posts' ) ) { die; }");
  assert.deepEqual(codes(diff({ "a.php": before }, { "a.php": more })), ["check-added:ajax:acme_go"]);
});

test("REST: a missing permission_callback is public, __return_true too, and a custom callback is not ranked", () => {
  const route = (perm) => `<?php
register_rest_route( 'acme/v1', '/items', array(
  'methods' => 'POST',
  'callback' => 'acme_save',
  ${perm}
) );
function acme_save() { update_option( 'x', 1 ); }
function acme_can() { return current_user_can( 'edit_posts' ); }
function acme_key() { return hash_equals( 'k', $_SERVER['HTTP_X_KEY'] ?? '' ); }
`;
  const gate = (perm) => inventory([{ path: "a.php", code: route(perm) }]).entries.get("rest:POST acme/v1/items").gate;
  assert.equal(gate("").rank, -1);
  assert.equal(gate("").publicByDefault, true);
  assert.equal(gate("'permission_callback' => '__return_true',").rank, -1);
  assert.equal(gate("'permission_callback' => '__return_false',").rank, 6);
  assert.equal(gate("'permission_callback' => 'acme_can',").rank, 1);
  assert.equal(gate("'permission_callback' => 'acme_key',").rank, null);
  assert.equal(gate("'permission_callback' => 'acme_key',").opaque, true);
  // A custom rule replaced by __return_true is a warning at most: the tool cannot say who passed the rule.
  assert.deepEqual(codes(diff({ "a.php": route("'permission_callback' => 'acme_key',") }, { "a.php": route("'permission_callback' => '__return_true',") })), []);
});

test("REST methods: constants, strings and lists give the same key", () => {
  const keys = (methods) =>
    [...inventory([{ path: "a.php", code: `<?php register_rest_route( 'a/v1', '/x', array( 'methods' => ${methods}, 'callback' => 'f', 'permission_callback' => '__return_true' ) );` }]).entries.keys()];
  assert.deepEqual(keys("WP_REST_Server::EDITABLE"), ["rest:PATCH,POST,PUT a/v1/x"]);
  assert.deepEqual(keys("'POST, PUT, PATCH'"), ["rest:PATCH,POST,PUT a/v1/x"]);
  assert.deepEqual(keys("array( 'PUT', 'PATCH', 'POST' )"), ["rest:PATCH,POST,PUT a/v1/x"]);
  assert.deepEqual(keys("'get'"), ["rest:GET a/v1/x"]);
});

test("a new visitor-facing handler for an existing action is now-public; a new one that only reads is information", () => {
  const before = ajax("update_option( 'x', 1 );");
  const after = ajax("update_option( 'x', 1 );", "add_action( 'wp_ajax_nopriv_acme_go', 'acme_go' );");
  assert.deepEqual(codes(diff({ "a.php": before }, { "a.php": after })), ["now-public:ajax-nopriv:acme_go"]);
  const reads = "<?php\nadd_action( 'wp_ajax_nopriv_acme_list', function () { wp_send_json( get_option( 'x' ) ); } );\n";
  assert.deepEqual(codes(diff({ "a.php": "<?php\n" }, { "a.php": reads })), ["added:ajax-nopriv:acme_list"]);
});

test("the capability table matches WordPress's default roles and meta capabilities", () => {
  assert.equal(capInfo("read").rank, 0);
  assert.equal(capInfo("edit_posts").rank, 1);
  assert.equal(capInfo("upload_files").rank, 2);
  assert.equal(capInfo("edit_others_posts").rank, 3);
  assert.equal(capInfo("unfiltered_html").rank, 3);
  assert.equal(capInfo("manage_options").rank, 4);
  assert.equal(capInfo("create_users").rank, 4);
  assert.equal(capInfo("manage_network_options").rank, 5);
  assert.deepEqual(capInfo("edit_post"), { rank: 1, meta: true, needsObject: true });
  assert.equal(capInfo("customize").rank, 4);
  assert.equal(capInfo("assign_categories").rank, 1);
  assert.equal(capInfo("manage_woocommerce").rank, null);
  assert.equal(primitiveOf("delete_user"), "delete_users");
  assert.equal(capInfo("Manage_Options").rank, 4);
});
