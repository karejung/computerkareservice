'use client';

import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export type BloomProps = {
  enabled: boolean;
  strength: number;
  radius: number;
  threshold: number;
};

export function Bloom({ enabled, strength, radius, threshold }: BloomProps) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);

  const rig = useMemo(() => {
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 4,
    });

    const composer = new EffectComposer(gl, target);
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), strength, radius, threshold);

    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(bloom);

    composer.addPass(new OutputPass());

    return { composer, bloom, target };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera]);

  useEffect(() => {
    return () => {
      rig.bloom.dispose();
      rig.composer.dispose();
      rig.target.dispose();
    };
  }, [rig]);

  useLayoutEffect(() => {
    rig.composer.setPixelRatio(dpr);
    rig.composer.setSize(size.width, size.height);
  }, [rig, dpr, size]);

  useEffect(() => {
    rig.bloom.strength = strength;
    rig.bloom.radius = radius;
    rig.bloom.threshold = threshold;
  }, [rig, strength, radius, threshold]);

  useFrame(() => {
    if (enabled) {
      rig.composer.render();
    } else {
      gl.setRenderTarget(null);
      gl.render(scene, camera);
    }
  }, 1);

  return null;
}
