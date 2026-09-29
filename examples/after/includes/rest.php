<?php
namespace Example\Tools;

add_action( 'rest_api_init', __NAMESPACE__ . '\register_routes' );

function register_routes() {
	register_rest_route(
		'example/v1',
		'/settings',
		array(
			array(
				'methods'             => \WP_REST_Server::READABLE,
				'callback'            => __NAMESPACE__ . '\get_settings',
				'permission_callback' => __NAMESPACE__ . '\can_manage',
			),
			array(
				'methods'  => \WP_REST_Server::EDITABLE,
				'callback' => __NAMESPACE__ . '\save_settings',
			),
		)
	);
	register_rest_route(
		'example/v1',
		'/stats',
		array(
			'methods'             => 'GET',
			'callback'            => __NAMESPACE__ . '\get_stats',
			'permission_callback' => 'is_user_logged_in',
		)
	);
}

function can_manage() {
	return current_user_can( 'manage_options' );
}

function get_settings() {
	return get_option( 'example_settings' );
}

function save_settings( $request ) {
	update_option( 'example_settings', $request->get_param( 'settings' ) );
	return true;
}

function get_stats() {
	return array( 'notes' => 0 );
}
