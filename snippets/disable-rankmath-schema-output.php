<?php
/**
 * Remove RankMath Auto-Generated Schema — Keep Custom Post Meta Schemas
 *
 * RankMath outputs two kinds of JSON-LD:
 *   1. Auto-generated: WebPage, BreadcrumbList, WebSite, Organization, ImageObject
 *      (built on the fly from global settings and page content)
 *   2. Custom schemas: Stored in rank_math_schema_* post meta
 *      (inserted by the Schematic app via the helper plugin)
 *
 * This snippet removes ONLY the auto-generated ones so your custom schemas
 * are the only structured data on each page.
 *
 * Installation:
 *   Option A: Copy this file to wp-content/mu-plugins/
 *   Option B: Paste the code into your theme's functions.php
 *   Option C: Use a code-snippets plugin (e.g. WPCode)
 */

add_filter( 'rank_math/json_ld', function( $data, $jsonld ) {

    // These keys are RankMath's auto-generated schema nodes.
    // Custom schemas from post meta come through as 'richSnippet' or numbered keys.
    $auto_generated_keys = [
        'WebPage',
        'BreadcrumbList',
        'WebSite',
        'Organization',
        'Person',
        'publisher',
        'ProfilePage',
        'SiteNavigationElement',
        'ImageObject',
    ];

    foreach ( $auto_generated_keys as $key ) {
        unset( $data[ $key ] );
    }

    return $data;

}, 99, 2 );
