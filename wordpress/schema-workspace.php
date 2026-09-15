<?php
/**
 * Plugin Name: Schema Workspace Connector
 * Description: Application Password authenticated schema storage and public JSON-LD output for Schema Workspace.
 * Version: 1.2.0
 */
defined('ABSPATH') || exit;

function swc_allowed() { return current_user_can('edit_posts'); }
function swc_target($request) {
    $url = esc_url_raw($request['url']);
    $home = wp_parse_url(home_url());
    $parts = wp_parse_url($url);
    if (!$parts || strtolower($parts['host'] ?? '') !== strtolower($home['host']) ||
        ($parts['port'] ?? null) !== ($home['port'] ?? null)) {
        return new WP_Error('invalid_site', 'URL must belong to this WordPress site.', array('status' => 400));
    }
    $id = url_to_postid($url);
    if (!$id && untrailingslashit($url) === untrailingslashit(home_url()) && get_option('show_on_front') === 'page') {
        $id = (int) get_option('page_on_front');
    }
    $post = $id ? get_post($id) : null;
    if (!$post || $post->post_status !== 'publish' || $post->post_password) {
        return new WP_Error('not_found', 'URL is not a public published post, page, or custom post. Archives are not supported.', array('status' => 404));
    }
    if (!current_user_can('edit_post', $id)) return new WP_Error('forbidden', 'Cannot edit this post.', array('status' => 403));
    return $id;
}
function swc_snapshot($id) {
    return array('postId' => $id, 'url' => get_permalink($id), 'schema' => get_post_meta($id, '_schema_workspace_jsonld', true) ?: null, 'suppressesRankMath' => (bool) get_post_meta($id, '_schema_workspace_suppress_rankmath', true), 'schemaControl' => 1);
}
add_action('rest_api_init', function () {
    register_rest_route('schema-workspace/v1', '/status', array(
        'methods' => 'GET', 'permission_callback' => 'swc_allowed',
        'callback' => function () { return array('success' => true, 'version' => '1.2.0', 'rankMath' => defined('RANK_MATH_VERSION'), 'rankMathPro' => defined('RANK_MATH_PRO_VERSION'), 'siteUrl' => home_url(), 'user' => wp_get_current_user()->display_name); }
    ));
    register_rest_route('schema-workspace/v1', '/restore', array(
        'methods' => 'POST', 'permission_callback' => 'swc_allowed',
        'callback' => function ($request) {
            $id = swc_target($request);
            if (is_wp_error($id)) return $id;
            $current = swc_snapshot($id);
            if (!$request->has_param('expected') || $request->get_param('expected') != $current['schema'] || (bool) $request->get_param('expectedSuppression') !== $current['suppressesRankMath']) return new WP_Error('conflict', 'Schema changed after insertion.', array('status' => 409));
            $schema = $request->get_param('schema');
            if (!$request->has_param('schema') || ($schema !== null && (!is_array($schema) || ($schema['@context'] ?? '') !== 'https://schema.org' || empty($schema['@graph'])))) return new WP_Error('invalid_backup', 'Invalid schema backup.', array('status' => 400));
            update_post_meta($id, '_schema_workspace_previous', wp_slash($current));
            if ($schema === null) delete_post_meta($id, '_schema_workspace_jsonld');
            else update_post_meta($id, '_schema_workspace_jsonld', wp_slash($schema));
            update_post_meta($id, '_schema_workspace_suppress_rankmath', (bool) $request->get_param('suppressRankMath'));
            clean_post_cache($id);
            return swc_snapshot($id);
        }
    ));
    register_rest_route('schema-workspace/v1', '/schema', array(
        array('methods' => 'GET', 'permission_callback' => 'swc_allowed', 'callback' => function ($request) {
            $id = swc_target($request);
            return is_wp_error($id) ? $id : swc_snapshot($id);
        }),
        array('methods' => 'POST', 'permission_callback' => 'swc_allowed', 'callback' => function ($request) {
            $id = swc_target($request);
            if (is_wp_error($id)) return $id;
            $schema = $request->get_param('schema');
            $removing = $request->get_param('removeExisting') === true && $schema === null;
            if (!$removing && (!is_array($schema) || ($schema['@context'] ?? '') !== 'https://schema.org' ||
                empty($schema['@graph']) || !is_array($schema['@graph']) || strlen(wp_json_encode($schema)) > 500000)) {
                return new WP_Error('invalid_schema', 'A nonempty JSON-LD graph under 500KB is required.', array('status' => 400));
            }
            foreach (($schema['@graph'] ?? array()) as $node) {
                if (!is_array($node) || empty($node['@type'])) return new WP_Error('invalid_schema', 'Each graph node needs @type.', array('status' => 400));
            }
            $before = swc_snapshot($id);
            if (!$request->has_param('expected') || $request->get_param('expected') != $before['schema'] || (bool) $request->get_param('expectedSuppression') !== $before['suppressesRankMath']) {
                return new WP_Error('conflict', 'Schema changed since preview. Refresh and retry.', array('status' => 409));
            }
            // Keep a previous version within WordPress too. Do not touch post content or SEO plugin fields.
            update_post_meta($id, '_schema_workspace_previous', wp_slash($before));
            if ($removing) delete_post_meta($id, '_schema_workspace_jsonld');
            else update_post_meta($id, '_schema_workspace_jsonld', wp_slash($schema));
            update_post_meta($id, '_schema_workspace_suppress_rankmath', $removing || $request->get_param('suppressRankMath') === true);
            clean_post_cache($id);
            $after = swc_snapshot($id);
            if ($after['schema'] != $schema) return new WP_Error('write_failed', 'Stored schema verification failed.', array('status' => 500));
            return array('success' => true, 'postId' => $id, 'schema' => $after['schema']);
        })
    ));
});
add_action('wp_head', function () {
    if (defined('RANK_MATH_VERSION')) return; // Rank Math owns the public graph when active.
    if (!is_singular() || post_password_required()) return;
    $schema = get_post_meta(get_queried_object_id(), '_schema_workspace_jsonld', true);
    if (is_array($schema) && !empty($schema['@graph'])) {
        echo '<script id="schema-workspace-jsonld" type="application/ld+json">';
        echo wp_json_encode($schema, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES);
        echo '</script>';
    }
}, 99);

// Extend Rank Math's documented frontend graph without editing its internal metadata.
add_filter('rank_math/json_ld', function ($data) {
    if (!is_singular() || post_password_required() || !is_array($data)) return $data;
    if (get_post_meta(get_queried_object_id(), '_schema_workspace_suppress_rankmath', true)) $data = array();
    $schema = get_post_meta(get_queried_object_id(), '_schema_workspace_jsonld', true);
    if (!is_array($schema) || empty($schema['@graph'])) return $data;
    $ids = array();
    foreach ($data as $node) if (is_array($node) && isset($node['@id'])) $ids[] = $node['@id'];
    foreach ($schema['@graph'] as $index => $node) {
        // Fail closed on an entity-ID collision. Public verification will report missing output.
        if (isset($node['@id']) && in_array($node['@id'], $ids, true)) continue;
        $key = 'schema_workspace_' . $index;
        if (!isset($data[$key])) $data[$key] = $node;
    }
    return $data;
}, 99);
