<?php
// TEST ENVIRONMENT ONLY. Never install on production: permits local HTTP app passwords.
add_filter('wp_is_application_passwords_available', '__return_true');
add_action('init', function () {
    register_post_type('fixture_item', [
        'public' => true, 'show_in_rest' => true, 'rest_namespace' => 'catalog/v3',
        'rest_base' => 'items', 'supports' => ['title', 'editor', 'custom-fields'],
        'rewrite' => ['slug' => 'catalog']
    ]);
    foreach (['page', 'post', 'fixture_item'] as $type) {
        register_post_meta($type, getenv('FIXTURE_KEY'), [
            'single' => true,
            'type' => getenv('FIXTURE_ENCODING') === 'object' ? 'object' : 'string',
            'show_in_rest' => getenv('FIXTURE_ENCODING') === 'object'
                ? ['schema' => ['type' => 'object', 'additionalProperties' => true]] : true,
            'auth_callback' => function ($allowed, $key, $post_id) { return current_user_can('edit_post', $post_id); }
        ]);
    }
});
add_action('wp_head', function () {
    if (!is_singular()) return;
    $value = get_post_meta(get_queried_object_id(), getenv('FIXTURE_KEY'), true);
    $schema = is_string($value) ? json_decode($value, true) : $value;
    if (!empty($schema)) echo '<script type="application/ld+json">' . wp_json_encode($schema, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) . '</script>';
});
