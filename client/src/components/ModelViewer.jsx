import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { api } from '../api';
import { generateThumbnail } from '../utils/thumbnail';

export default function ModelViewer({ file, onClose, onThumbnail }) {
  const mountRef = useRef(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [errorMsg, setErrorMsg] = useState('');
  const [progress, setProgress] = useState(null); // 0-100 or null when unknown

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const mount = mountRef.current;
    let disposed = false;
    let frameId;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1420);

    const camera = new THREE.PerspectiveCamera(
      50,
      mount.clientWidth / mount.clientHeight,
      0.01,
      1000
    );
    camera.position.set(2, 1.5, 2);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x223044, 1.4));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    const animate = () => {
      frameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      if (!mount.clientWidth) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener('resize', onResize);

    (async () => {
      try {
        // Signed URL → the model streams directly from Supabase's CDN
        const { url } = await api.getFileUrl(file.id);
        const res = await fetch(url);
        if (!res.ok) throw new Error('Could not load the model from storage');

        // Stream the body so we can show download progress
        const total = Number(res.headers.get('content-length')) || file.size_bytes || 0;
        const reader = res.body.getReader();
        const chunks = [];
        let loaded = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.length;
          if (total > 0 && !disposed) {
            setProgress(Math.min(100, Math.round((loaded / total) * 100)));
          }
        }
        if (disposed) return;
        const bytes = new Uint8Array(loaded);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const buffer = bytes.buffer;
        new GLTFLoader().parse(
          buffer,
          '',
          (gltf) => {
            if (disposed) return;
            const model = gltf.scene;

            // Center the model and frame the camera around it
            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z) || 1;
            model.position.sub(center);
            scene.add(model);

            const grid = new THREE.GridHelper(maxDim * 4, 20, 0x2e3a55, 0x1d2639);
            grid.position.y = -size.y / 2;
            scene.add(grid);

            camera.near = maxDim / 100;
            camera.far = maxDim * 100;
            camera.position.set(maxDim * 1.3, maxDim * 0.9, maxDim * 1.3);
            camera.updateProjectionMatrix();
            controls.target.set(0, 0, 0);
            controls.update();

            setStatus('ready');

            // Backfill: files uploaded before thumbnails existed get one now
            if (!file.thumbnail && onThumbnail) {
              generateThumbnail(buffer).then((thumb) => {
                if (!thumb || disposed) return;
                api
                  .setThumbnail(file.id, thumb)
                  .then(() => onThumbnail(file.id, thumb))
                  .catch(() => {});
              });
            }
          },
          () => {
            if (!disposed) {
              setErrorMsg('Failed to parse this GLB file');
              setStatus('error');
            }
          }
        );
      } catch (err) {
        if (!disposed) {
          setErrorMsg(err.message);
          setStatus('error');
        }
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, [file.id]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="viewer-modal" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-header">
          <strong className="viewer-title">{file.original_name}</strong>
          <button className="btn small" onClick={onClose}>
            Close ✕
          </button>
        </div>
        <div className="viewer-canvas" ref={mountRef}>
          {status === 'loading' && (
            <div className="viewer-overlay">
              {progress === null
                ? 'Loading model…'
                : progress < 100
                  ? `Downloading model… ${progress}%`
                  : 'Preparing model…'}
            </div>
          )}
          {status === 'error' && (
            <div className="viewer-overlay error">{errorMsg}</div>
          )}
        </div>
        <div className="viewer-hint muted">
          Drag to rotate · Scroll to zoom · Right-drag to pan · Esc to close
        </div>
      </div>
    </div>
  );
}
