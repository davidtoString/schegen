<?php
define('WP_INSTALLING', true);
$_SERVER['HTTP_HOST'] = parse_url(getenv('FIXTURE_URL'), PHP_URL_HOST) . ':' . parse_url(getenv('FIXTURE_URL'), PHP_URL_PORT);
require '/var/www/html/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
if (($argv[1] ?? '') === 'rankmath') {
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    if (!file_exists(WP_PLUGIN_DIR . '/seo-by-rank-math/rank-math.php')) {
        WP_Filesystem();
        $archive = download_url('https://downloads.wordpress.org/plugin/seo-by-rank-math.latest-stable.zip');
        if (is_wp_error($archive)) throw new Exception($archive->get_error_message());
        $result = unzip_file($archive, WP_PLUGIN_DIR);
        if (is_wp_error($result)) throw new Exception($result->get_error_message());
    }
    $result = activate_plugin('seo-by-rank-math/rank-math.php');
    if (is_wp_error($result)) throw new Exception($result->get_error_message());
    update_option('active_plugins', ['seo-by-rank-math/rank-math.php', 'schema-workspace.php']);
    update_option('rank_math_registration_skip', true); // Free plugin's optional account connection is skipped in the fixture.
    $modules = get_option('rank_math_modules', []);
    $modules[] = 'rich-snippet';
    update_option('rank_math_modules', array_values(array_unique($modules)));
    echo 'Rank Math enabled in fixture';
    exit;
}
if (($argv[1] ?? '') === 'connector') {
    update_option('active_plugins', ['schema-workspace.php']);
    echo 'Connector activated in fixture';
    exit;
}
if (!is_blog_installed()) {
    wp_install('Schema integration fixture', 'fixture_admin', 'fixture@example.test', true, '', wp_generate_password(32));
}
update_option('home', getenv('FIXTURE_URL'));
update_option('siteurl', getenv('FIXTURE_URL'));
update_option('permalink_structure', '/%postname%/');
update_option('active_plugins', []); // This installation is exclusively a test fixture.
$editor = get_user_by('login', 'fixture_editor');
if (!$editor) {
    $id = wp_insert_user(['user_login' => 'fixture_editor', 'user_pass' => wp_generate_password(32), 'role' => 'editor']);
    $editor = get_user_by('id', $id);
}
wp_set_current_user($editor->ID);
$page = get_page_by_path('fixture-about');
$page_id = $page ? $page->ID : wp_insert_post([
    'post_type' => 'page', 'post_status' => 'publish', 'post_name' => 'fixture-about',
    'post_title' => 'About the publishing studio', 'post_content' => 'We publish illustrated books about local history and culture.', 'post_author' => $editor->ID
]);
$product = get_page_by_path('fixture-item', OBJECT, 'fixture_item');
$product_id = $product ? $product->ID : wp_insert_post([
    'post_type' => 'fixture_item', 'post_status' => 'publish', 'post_name' => 'fixture-item',
    'post_title' => 'Local history book', 'post_content' => 'An illustrated guide to the history of our town.', 'post_author' => $editor->ID
]);
update_option('show_on_front', 'page');
update_option('page_on_front', $page_id);
foreach ([$page_id, $product_id] as $fixture_id) {
    delete_post_meta($fixture_id, getenv('FIXTURE_KEY'));
    delete_post_meta($fixture_id, '_schema_workspace_jsonld');
    delete_post_meta($fixture_id, '_schema_workspace_suppress_rankmath');
}
global $wp_rewrite;
$wp_rewrite->init();
flush_rewrite_rules(true);
WP_Application_Passwords::delete_all_application_passwords($editor->ID);
$password = WP_Application_Passwords::create_new_application_password($editor->ID, ['name' => 'Schema fixture test']);
global $wpdb, $wp_version;
echo wp_json_encode(['url' => getenv('FIXTURE_URL'), 'username' => $editor->user_login,
    'appPassword' => $password[0], 'prefix' => $wpdb->prefix, 'version' => $wp_version,
    'key' => getenv('FIXTURE_KEY'), 'encoding' => getenv('FIXTURE_ENCODING'),
    'urls' => [get_permalink($page_id), get_permalink($product_id)]]);
