<?php
namespace Example\Tools;

class Admin {
	public function __construct() {
		add_action( 'wp_ajax_example_save_settings', array( $this, 'save_settings' ) );
		add_action( 'wp_ajax_example_update_note', array( $this, 'update_note' ) );
		add_action( 'wp_ajax_example_export', array( $this, 'export' ) );
		add_action( 'wp_ajax_example_subscribe', array( $this, 'subscribe' ) );
		add_action( 'wp_ajax_example_clear_log', array( $this, 'clear_log' ) );
		add_action( 'wp_ajax_example_dismiss', array( $this, 'dismiss' ) );
		add_action( 'wp_ajax_example_legacy_sync', array( $this, 'legacy_sync' ) );
		add_action( 'admin_post_example_reset', array( $this, 'reset' ) );
		add_action( 'admin_menu', array( $this, 'menu' ) );
	}

	public function menu() {
		add_options_page( 'Example Tools', 'Example Tools', 'manage_options', 'example-tools', array( $this, 'page' ) );
		add_submenu_page( 'tools.php', 'Example Reports', 'Example Reports', 'manage_options', 'example-reports', array( $this, 'page' ) );
	}

	public function save_settings() {
		check_ajax_referer( 'example_settings' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_send_json_error( null, 403 );
		}
		update_option( 'example_settings', $this->clean( $_POST['settings'] ?? array() ) );
		wp_send_json_success();
	}

	public function update_note() {
		check_ajax_referer( 'example_note' );
		$post_id = absint( $_POST['post_id'] ?? 0 );
		if ( ! current_user_can( 'edit_post', $post_id ) ) {
			wp_send_json_error( null, 403 );
		}
		update_post_meta( $post_id, '_example_note', sanitize_text_field( wp_unslash( $_POST['note'] ?? '' ) ) );
		wp_send_json_success();
	}

	public function export() {
		check_ajax_referer( 'example_export' );
		$this->authorize();
		wp_send_json_success( get_option( 'example_settings' ) );
	}

	private function authorize() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( -1, 403 );
		}
	}

	public function subscribe() {
		check_ajax_referer( 'example_subscribe' );
		add_user_meta( get_current_user_id(), '_example_subscribed', 1, true );
		wp_send_json_success();
	}

	public function clear_log() {
		check_ajax_referer( 'example_clear_log' );
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_send_json_error( null, 403 );
		}
		delete_option( 'example_log' );
		wp_send_json_success();
	}

	public function dismiss() {
		check_ajax_referer( 'example_dismiss' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_send_json_error( null, 403 );
		}
		update_option( 'example_notice_dismissed', 1 );
		wp_send_json_success();
	}

	public function legacy_sync() {
		check_ajax_referer( 'example_legacy_sync' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_send_json_error( null, 403 );
		}
		update_option( 'example_synced', time() );
		wp_send_json_success();
	}

	public function reset() {
		check_admin_referer( 'example_reset' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( 'Not allowed', 403 );
		}
		delete_option( 'example_settings' );
		wp_safe_redirect( admin_url( 'options-general.php?page=example-tools' ) );
		exit;
	}

	public function page() {
		echo '<div class="wrap"></div>';
	}

	private function clean( $settings ) {
		return array_map( 'sanitize_text_field', (array) $settings );
	}
}
