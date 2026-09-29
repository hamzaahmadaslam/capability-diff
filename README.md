# capability-diff

Compares who can run each operation of a WordPress plugin or theme in two versions, and reports the changes that
let more users in.

Code review catches a handler with no permission check at all. The quieter regressions look harmless in a diff:
`current_user_can( 'edit_post', $post_id )` becomes `current_user_can( 'edit_posts' )` and every contributor can
edit every post; `manage_options` becomes `edit_posts` in a helper three calls away; the check moves below the
`update_option()` it was guarding; a REST route loses its `permission_callback`, which WordPress then serves to
anyone. capability-diff reads the PHP of both versions (it never runs it), finds every operation a user can
trigger, follows each handler into the code it calls, and compares what stands in front of it.

It works on two folders, on two git revisions, or in a pull request as a GitHub Action.

## What it looks at

| Operation   | Registered with                                          | Who can reach the handler before any check        |
| ----------- | -------------------------------------------------------- | ------------------------------------------------- |
| AJAX        | `add_action( 'wp_ajax_…' )` and `wp_ajax_nopriv_…`        | Logged-in users; visitors too for `nopriv`         |
| admin-post  | `add_action( 'admin_post_…' )` and `admin_post_nopriv_…`  | Logged-in users; visitors too for `nopriv`         |
| REST        | `register_rest_route()`, one entry per endpoint and method set | Anyone, until the `permission_callback` says no |
| Admin page  | `add_menu_page()`, `add_submenu_page()`, `add_options_page()` and the other `add_*_page()` helpers | Users with the capability argument |

For each one it records, in the order the code runs them:

- capability checks: `current_user_can()`, `user_can()`, `current_user_can_for_site()`, `->has_cap()`,
  `is_user_logged_in()`, `is_super_admin()`, with the capability, whether an object ID is passed, and the condition
  around the check;
- nonce checks: `check_ajax_referer()`, `check_admin_referer()`, `wp_verify_nonce()`;
- the first write: options, post, user, term and comment meta, `wp_insert_post()` and the other insert, update and
  delete functions, `$wpdb->insert()`, `update()`, `delete()`, `replace()` and `query()`, file writes and uploads.

Callbacks are followed when they are a function name (namespaced strings included), `array( $this, 'method' )`,
`array( __CLASS__, 'method' )`, `'Class::method'`, a closure, or an object in a variable whose method name only one
class has. Inside a handler, calls to the codebase's own functions, `$this->method()`, `self::`, `static::` and
`parent::` are followed four levels deep.

## How it ranks access

Every capability is ranked by the lowest default WordPress role that has it, from `populate_roles()` and
`map_meta_cap()` in WordPress core: logged-out visitor, any logged-in user (`read`, `is_user_logged_in()`),
contributor (`edit_posts`), author (`upload_files`, `publish_posts`), editor (`edit_others_posts`,
`moderate_comments`), administrator (`manage_options`, `edit_users`), super admin (`manage_network_options`). Meta
capabilities such as `edit_post` rank as the primitive they map to, and are marked as needing an object.

A plugin's own capabilities (`manage_woocommerce`, `edit_shop_orders`, anything custom) have no default rank: their
width depends on the site's roles, so a change involving one is reported for a person, or Jev, to judge.

## What it reports

| Finding              | Severity | What changed                                                                             |
| -------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `now-public`         | Wider    | Logged-out visitors can now reach it: a `nopriv` handler with no check, or a REST route that became public |
| `check-removed`      | Wider    | It had a capability check and has none now                                              |
| `capability-lowered` | Wider    | The capability now belongs to a wider role (`manage_options` to `edit_posts`)            |
| `object-dropped`     | Wider    | A meta capability checked for one object (`edit_post`, `$id`) is now checked without it   |
| `check-after-write`  | Wider    | The check used to come before the first write and now comes after it                     |
| `nonce-removed`      | Wider    | An AJAX or admin-post action stopped verifying a nonce (cross-site request forgery)       |
| `capability-changed` | Check    | A capability changed where the tool cannot rank both sides                               |
| `condition-changed`  | Check    | Same capabilities, different condition around them (`&& ! $is_helper` added), or a different object |
| `new-unchecked`      | Check    | A new operation open to visitors or any logged-in user that writes without a check       |
| `capability-raised`  | Info     | Narrower access                                                                          |
| `capability-swapped` | Info     | Different capabilities of the same rank                                                  |
| `check-added`, `nonce-added`, `added`, `removed` | Info | New protection, new or removed operations               |

A handler whose callback cannot be followed is listed by name at the end of the report and not compared.

## Install

```sh
npm install -g github:hamzaahmadaslam/capability-diff
```

Node 20 or later. One dependency, [php-parser](https://www.npmjs.com/package/php-parser), pinned.

## Usage

```sh
# Two folders, for example two unpacked releases
capability-diff my-plugin-2.3.0/ my-plugin-2.4.0/

# Two git revisions of the current repository (read with git show; nothing is checked out)
capability-diff --git v2.3.0 v2.4.0

# A release tag against the files on disk
capability-diff --git v2.3.0
```

| Option               | Meaning                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `--path <dir>`       | Only this folder of the repository (with `--git`), for a monorepo            |
| `--exclude <a,b>`    | Folder names to skip, replacing the default list (`vendor`, `node_modules`, `.git`, `tests`, `test`) |
| `--fail-on <level>`  | Exit 1 on `wider` findings (default), on `warning` and worse, or `never`     |
| `--json`             | Print the findings as JSON, with the code behind each one                    |
| `--markdown <file>`  | Also write a Markdown summary, for a pull request or a job summary           |
| `--jev`              | Ask Jev about the findings marked Check (see below)                          |
| `--threshold <p>`    | How confident Jev must be before its answer is used (default 0.8)            |
| `--dry-run`          | With `--jev`: say how many questions would be sent, and send nothing          |

Exit codes: 0 when nothing reaches the `--fail-on` level, 1 when something does, 2 on a usage error.

## In a pull request (GitHub Action)

```yaml
name: Capability diff
on: pull_request
permissions:
  contents: read
jobs:
  authorization:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - uses: hamzaahmadaslam/capability-diff@main
        with:
          fail-on: wider
```

`fetch-depth: 0` gives the job the base commit to compare against. The summary table appears on the job's page.
Inputs: `base` (defaults to the pull request's base commit), `path`, `fail-on` and `jev`.

## Example

The `examples/` folder holds two versions of a small synthetic plugin (`before/` and `after/`, not code from any
real site), with one authorization change in each operation, and what capability-diff printed for them:

```text
capability-diff: examples/before -> examples/after
13 operations before, 14 after. 8 with wider access, 3 to check, 1 for information.

Wider access (8)
  ajax example_update_note  [object-dropped]
    The operation checked edit_post for one object before (current_user_can( 'edit_post', $post_id )); now the check has no object, so any user with edit_posts passes, whoever owns the object.
    before: includes/class-admin.php:7, includes/class-admin.php:32, includes/class-admin.php:34
    after:  includes/class-admin.php:7, includes/class-admin.php:33, includes/class-admin.php:35
  rest PATCH,POST,PUT example/v1/settings  [check-removed]
    The operation checked manage_options before and has no capability check now, so anyone (logged-out visitors too) can run it (the REST route has no permission_callback, which WordPress treats as public).
  …

Check (3)
  ajax example_clear_log  [capability-changed]
    The operation checked manage_woocommerce and now checks edit_shop_orders. Whether that lets more users in depends on how the site's roles grant these capabilities.
  …
```

The full output is in `examples/report.txt`, the JSON in `examples/report.json` and the Markdown summary in
`examples/summary.md`.

As a check against real code, comparing Ultimate Member's public repository at its last commit of 2023 with September 2026
(46 operations, about 270 PHP files, under 40 seconds with `--git`) gave no "wider" findings. It gave one finding to check,
where `! is_user_logged_in() || ! current_user_can( 'manage_options' )` became `! current_user_can( 'manage_options' )`,
and 47 for information, 25 of them nonces added to AJAX actions.

## How it uses Jev (optional)

Most findings are facts about the code and need no model. The three kinds marked Check need someone to read the
code: a change between capabilities the tool cannot rank, a changed condition around a check, and a new operation
that writes without a check. With `--jev`, those findings are sent to Jev, TypeSafe AI's System One model, which
answers typed questions with probabilities and writes no text.

Each finding becomes one yes/no question (a `noul`), all in one request:

- For a changed capability or condition: can any user who was denied this operation before the change reach it
  after the change?
- For a new operation: can a logged-out visitor or a subscriber run it and change stored data?

A "yes" at or above the threshold (0.8 by default) raises the finding to Wider, a confident "no" lowers it to
information, and anything between stays a Check marked `review`. Every answer is printed with its probability.
Findings marked Wider are never sent: they stand on the code alone.

Set the key first:

```sh
export TYPESAFE_API_KEY="<your key>"
capability-diff --git v2.3.0 v2.4.0 --jev
```

## What leaves your machine

Without `--jev`, nothing: the tool reads files and git history locally and makes no network call.

With `--jev`, one request to `api.typesafe.ai` for every 25 judged findings. Each question carries the operation's
name, where it is registered, the names of its handler and permission callback, and for each version up to four capability checks, two nonce
checks and the first write as they appear in the code, with the condition around each check (240 characters each
at most). No other code, and nothing about your environment. The key is read from `TYPESAFE_API_KEY` and only sent
in the `Authorization` header.

## Limits

- It reads code and does not run it. A capability held in a variable is compared as the text of the expression, a
  callback stored in a variable elsewhere is not followed, and code that handles `$_POST` on `init` or `admin_init`
  instead of an AJAX, admin-post or REST handler is not an operation it sees.
- Several checks in one handler are treated as all required (the highest rank counts). Checks that are
  alternatives (`current_user_can( 'a' ) || current_user_can( 'b' )`) can make a change look wider or narrower than
  it is; the condition text is in the report.
- Ranks are the default roles. A site that gives a capability to another role, or a multisite network (where some
  administrator capabilities belong to super admins only), can differ.
- `check-after-write` compares the order in the source, with called functions inlined where they are called. Writes
  and checks inside closures, loops over callbacks, or code reached only through hooks are not seen.
- Permission callbacks with their own logic (an API key, a signature, a custom rule) cannot be ranked, so changes to
  them are not reported as wider.

## Token use

The example above sends one request of about 3,400 characters for its three judged findings: roughly 280 input
tokens per finding at four characters a token. A finding with many long checks and conditions is larger, up to
about 1,700 tokens at the 240-character limits. Most pull requests have none or a handful of judged findings. Runs
without `--jev` send nothing.

## License

MIT. Made by [Hamza Ahmad Aslam](https://hamzaahmadaslam.com), WordPress and web performance engineer.
