/**
 * POST plugin.
 *
 * This runtime plugin is intentionally a no-op. Enabling it in a profile's
 * `plugins` array activates the companion POST TUI tab, which acts as a
 * request client for the selected profile.
 */
export default {
  name: 'post',
};
