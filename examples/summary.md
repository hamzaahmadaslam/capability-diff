### Capability diff: examples/before → examples/after

8 with wider access, 3 to check, 1 for information.

| Operation | Change | Where |
| --- | --- | --- |
| `admin-post example_reset` | Wider access: nonce-removed | includes/class-admin.php:14 |
| `ajax-nopriv example_subscribe` | Wider access: now-public | includes/class-admin.php:10 |
| `ajax example_export` | Wider access: capability-lowered | includes/class-admin.php:8 |
| `ajax example_save_settings` | Wider access: check-after-write | includes/class-admin.php:6 |
| `ajax example_update_note` | Wider access: object-dropped | includes/class-admin.php:7 |
| `menu example-reports` | Wider access: capability-lowered | includes/class-admin.php:20 |
| `rest GET example/v1/stats` | Wider access: capability-lowered | includes/rest.php:22 |
| `rest PATCH,POST,PUT example/v1/settings` | Wider access: check-removed | includes/rest.php:7 |
| `ajax example_clear_log` | Check: capability-changed | includes/class-admin.php:11 |
| `ajax example_dismiss` | Check: condition-changed | includes/class-admin.php:12 |
| `ajax example_import` | Check: new-unchecked | includes/class-admin.php:13 |
