import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Renders a GLB (ArrayBuffer) once into a small offscreen canvas. Uses the same framing
 * and lighting as the full ModelViewer so thumbnails match the preview.
 *
 * Resolves { thumbnail, dimensions }:
 *   thumbnail  - compact data-URL image, or null if rendering failed
 *   dimensions - the model's real size in metres, measured from its bounding box
 *                (glTF files are defined in metres), or null if it could not be read.
 *                Measured here rather than asked of the AI, because geometry is exact.
 */
export function generateThumbnail(buffer, size = 256) {
  return new Promise((resolve) => {
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        preserveDrawingBuffer: true,
      });
      renderer.setSize(size, size);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x161e30);
      const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x223044, 1.4));
      const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
      dirLight.position.set(5, 10, 7);
      scene.add(dirLight);

      const finish = (thumbnail, dimensions = null) => {
        renderer.dispose();
        resolve({ thumbnail, dimensions });
      };

      new GLTFLoader().parse(
        buffer,
        '',
        (gltf) => {
          try {
            const model = gltf.scene;
            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());
            const size3 = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size3.x, size3.y, size3.z) || 1;
            // Y is up in glTF, so width/depth are the floor footprint and height is Y
            const round = (n) => Math.round(n * 1000) / 1000;
            const dimensions = [size3.x, size3.z, size3.y].every(
              (n) => Number.isFinite(n) && n > 0
            )
              ? { width_m: round(size3.x), depth_m: round(size3.z), height_m: round(size3.y) }
              : null;
            model.position.sub(center);
            scene.add(model);

            camera.near = maxDim / 100;
            camera.far = maxDim * 100;
            camera.position.set(maxDim * 1.1, maxDim * 0.8, maxDim * 1.1);
            camera.lookAt(0, 0, 0);
            camera.updateProjectionMatrix();

            renderer.render(scene, camera);
            // Browsers without WebP support silently fall back to PNG
            let dataUrl = renderer.domElement.toDataURL('image/webp', 0.75);
            if (dataUrl.length > 150_000) {
              dataUrl = renderer.domElement.toDataURL('image/jpeg', 0.7);
            }
            finish(dataUrl.length <= 200_000 ? dataUrl : null, dimensions);
          } catch {
            finish(null);
          }
        },
        () => finish(null)
      );
    } catch {
      if (renderer) renderer.dispose();
      resolve(null);
    }
  });
}
