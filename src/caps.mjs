// How wide a capability is: the lowest default WordPress role that has it. Taken from populate_roles() in
// wp-admin/includes/schema.php and map_meta_cap() in wp-includes/capabilities.php.

/** Ranks, lowest first. A check passes for everyone at its rank and above. */
export const RANKS = [
  { rank: -1, name: "anyone (logged-out visitors too)" },
  { rank: 0, name: "any logged-in user" },
  { rank: 1, name: "contributor" },
  { rank: 2, name: "author" },
  { rank: 3, name: "editor" },
  { rank: 4, name: "administrator" },
  { rank: 5, name: "super admin (multisite)" },
  { rank: 6, name: "nobody (__return_false)" },
];

export const rankName = (rank) => RANKS.find((r) => r.rank === rank)?.name ?? "unknown";

const PRIMITIVE = new Map();
const add = (rank, caps) => caps.split(/\s+/).filter(Boolean).forEach((cap) => PRIMITIVE.set(cap, rank));

add(0, "read level_0 exist");
add(1, "edit_posts delete_posts level_1");
add(2, "upload_files publish_posts edit_published_posts delete_published_posts level_2");
add(
  3,
  `moderate_comments manage_categories manage_links unfiltered_html edit_others_posts edit_pages edit_others_pages
   edit_published_pages publish_pages delete_pages delete_others_pages delete_published_pages delete_others_posts
   delete_private_posts edit_private_posts read_private_posts delete_private_pages edit_private_pages
   read_private_pages level_3 level_4 level_5 level_6 level_7`,
);
add(
  4,
  `switch_themes edit_themes activate_plugins edit_plugins edit_users edit_files manage_options import
   unfiltered_upload edit_dashboard update_plugins delete_plugins install_plugins update_themes install_themes
   update_core list_users remove_users promote_users edit_theme_options delete_themes export delete_users
   create_users level_8 level_9 level_10`,
);
add(
  5,
  `manage_network manage_sites manage_network_users manage_network_plugins manage_network_themes
   manage_network_options create_sites delete_sites upgrade_network setup_network`,
);

/**
 * Meta capabilities: map_meta_cap() turns them into primitive ones, often by looking at an object. `to` is the
 * primitive capability for the widest case, and `object` says whether the check needs an object ID to mean
 * anything (edit_post with a post ID asks about that post; without one it cannot be answered).
 */
const META = new Map(
  Object.entries({
    edit_post: { to: "edit_posts", object: true },
    edit_page: { to: "edit_pages", object: true },
    delete_post: { to: "delete_posts", object: true },
    delete_page: { to: "delete_pages", object: true },
    read_post: { to: "read", object: true },
    read_page: { to: "read", object: true },
    publish_post: { to: "publish_posts", object: true },
    edit_post_meta: { to: "edit_posts", object: true },
    delete_post_meta: { to: "edit_posts", object: true },
    add_post_meta: { to: "edit_posts", object: true },
    edit_comment: { to: "edit_posts", object: true },
    edit_comment_meta: { to: "edit_posts", object: true },
    delete_comment_meta: { to: "edit_posts", object: true },
    add_comment_meta: { to: "edit_posts", object: true },
    edit_term: { to: "manage_categories", object: true },
    delete_term: { to: "manage_categories", object: true },
    assign_term: { to: "edit_posts", object: true },
    edit_term_meta: { to: "manage_categories", object: true },
    delete_term_meta: { to: "manage_categories", object: true },
    add_term_meta: { to: "manage_categories", object: true },
    edit_user: { to: "edit_users", object: true },
    remove_user: { to: "remove_users", object: true },
    promote_user: { to: "promote_users", object: true },
    delete_user: { to: "delete_users", object: true },
    edit_user_meta: { to: "edit_users", object: true },
    delete_user_meta: { to: "edit_users", object: true },
    add_user_meta: { to: "edit_users", object: true },
    create_app_password: { to: "edit_users", object: true },
    list_app_passwords: { to: "edit_users", object: true },
    read_app_password: { to: "edit_users", object: true },
    edit_app_password: { to: "edit_users", object: true },
    delete_app_passwords: { to: "edit_users", object: true },
    delete_app_password: { to: "edit_users", object: true },
    activate_plugin: { to: "activate_plugins", object: true },
    deactivate_plugin: { to: "activate_plugins", object: true },
    deactivate_plugins: { to: "activate_plugins", object: false },
    add_users: { to: "promote_users", object: false },
    upload_plugins: { to: "install_plugins", object: false },
    upload_themes: { to: "install_themes", object: false },
    edit_css: { to: "unfiltered_html", object: false },
    customize: { to: "edit_theme_options", object: false },
    delete_site: { to: "manage_options", object: false },
    manage_post_tags: { to: "manage_categories", object: false },
    edit_categories: { to: "manage_categories", object: false },
    edit_post_tags: { to: "manage_categories", object: false },
    delete_categories: { to: "manage_categories", object: false },
    delete_post_tags: { to: "manage_categories", object: false },
    assign_categories: { to: "edit_posts", object: false },
    assign_post_tags: { to: "edit_posts", object: false },
    update_php: { to: "update_core", object: false },
    update_https: { to: "update_core", object: false },
    export_others_personal_data: { to: "manage_options", object: false },
    erase_others_personal_data: { to: "manage_options", object: false },
    manage_privacy_options: { to: "manage_options", object: false },
  }),
);

/**
 * What a capability name means: { rank, meta, needsObject }. rank is null for capabilities WordPress does not
 * define (a plugin's own, such as manage_woocommerce), whose width depends on the site's roles.
 */
export function capInfo(cap) {
  if (typeof cap !== "string") return { rank: null, meta: false, needsObject: false };
  const name = cap.toLowerCase();
  const meta = META.get(name);
  if (meta) return { rank: PRIMITIVE.get(meta.to) ?? null, meta: true, needsObject: meta.object };
  return { rank: PRIMITIVE.has(name) ? PRIMITIVE.get(name) : null, meta: false, needsObject: false };
}

/** The primitive capability a meta capability stands for, or the name itself. */
export const primitiveOf = (cap) => META.get(String(cap).toLowerCase())?.to ?? String(cap).toLowerCase();
