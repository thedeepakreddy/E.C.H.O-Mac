/**
 * Software WebGL for the UI fixtures on a machine with no GPU.
 *
 * Chromium used to fall back to its software renderer for WebGL on its own.
 * Since Chromium 137 it does not: on a GPU-less machine (a container, most CI)
 * `new THREE.WebGLRenderer()` fails, the page logs an error, and a fixture
 * that asserts "no console errors" fails for a reason that has nothing to do
 * with the panel. A Mac has a GPU, so this does nothing there.
 *
 * Imported for its side effect, before `app.whenReady()`. Set
 * ECHO_TEST_HARDWARE_GL=1 to leave Chromium's default in place.
 */
import { app } from "electron";

if (process.platform !== "darwin" && !process.env.ECHO_TEST_HARDWARE_GL) {
  app.commandLine.appendSwitch("enable-unsafe-swiftshader");
}
