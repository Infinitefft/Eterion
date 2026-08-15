import { useEffect, useRef } from 'react';
import * as THREE from 'three';

const targetFrameDuration = 1000 / 45;
const maxDevicePixelRatio = 1.5;

const backgroundVertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const backgroundFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec4 uAuroraA;
  uniform vec4 uAuroraB;
  uniform vec4 uAuroraC;
  uniform vec4 uAuroraMotionA;
  uniform vec4 uAuroraMotionB;
  uniform vec4 uAuroraMotionC;
  uniform vec4 uAuroraRangeA;
  uniform vec4 uAuroraRangeB;
  uniform vec4 uAuroraRangeC;
  uniform float uAuroraBoundary;
  uniform float uAuroraAspect;

  varying vec2 vUv;

  vec4 auroraRibbon(vec2 uv, vec4 shape, vec4 motion, vec4 range) {
    float seed = shape.w;
    float phase = motion.x + uTime * motion.y;
    float primaryWave = sin(uv.x * motion.w + phase) * motion.z;
    float secondaryWave = sin(uv.x * motion.w * 2.17 - phase * 0.63 + seed * 6.283) * motion.z * 0.34;
    float slowDrift = sin(uTime * 0.12 + seed * 8.0) * 0.026;
    float directionalSlope = (uv.x - 0.5) * range.z * uAuroraAspect;
    float center = shape.x + primaryWave + secondaryWave + slowDrift + directionalSlope;
    float ribbonDistance = abs(uv.y - center);

    float widthFlow = sin(uv.x * 13.0 - phase * 0.7 + seed * 11.0) * 0.5 + 0.5;
    float ribbonWidth = shape.y * mix(0.78, 1.14, widthFlow);
    float outerGlow = exp(-pow(ribbonDistance / ribbonWidth, 2.0));
    float innerGlow = exp(-pow(ribbonDistance / (ribbonWidth * 0.43), 2.0));

    float strandOffset = sin(uv.x * 21.0 + phase * 1.25 + seed * 17.0) * ribbonWidth * 0.16;
    float strandDistance = abs(uv.y - center - strandOffset);
    float fineStrand = exp(-pow(strandDistance / (ribbonWidth * 0.115), 2.0));

    float horizontalFade = smoothstep(range.x - 0.08, range.x + 0.04, uv.x);
    horizontalFade *= 1.0 - smoothstep(range.y - 0.04, range.y + 0.08, uv.x);
    float shimmer = 0.82 + 0.18 * sin(uv.x * 28.0 - phase * 0.82 + seed * 23.0);
    float opacity = shape.z * horizontalFade * shimmer;
    float alpha = opacity * (outerGlow * 0.18 + innerGlow * 0.24 + fineStrand * 0.1);

    vec3 blue = vec3(0.46, 0.62, 0.87);
    vec3 cyan = vec3(0.48, 0.79, 0.76);
    vec3 violet = vec3(0.64, 0.53, 0.85);
    vec3 ribbonColor = mix(blue, cyan, 0.28 + widthFlow * 0.42);
    ribbonColor = mix(ribbonColor, violet, 0.08 + 0.13 * sin(seed * 19.0) * 0.5 + 0.065);

    return vec4(ribbonColor, alpha);
  }

  void main() {
    float edgeX = smoothstep(0.0, 0.15, vUv.x) * smoothstep(0.0, 0.15, 1.0 - vUv.x);
    float edgeY = smoothstep(0.0, 0.18, vUv.y) * smoothstep(0.0, 0.18, 1.0 - vUv.y);
    float edgeFade = edgeX * edgeY;

    vec2 flowOffset = vec2(
      sin(vUv.y * 4.2 + uTime * 0.13),
      cos(vUv.x * 3.6 - uTime * 0.11)
    ) * 0.026;
    vec2 flowUv = vUv + flowOffset;

    vec2 roamingCenterA = vec2(
      0.5 + sin(uTime * 0.17 + 0.8) * 0.29,
      0.51 + sin(uTime * 0.23 + 2.1) * 0.17
    );
    vec2 roamingCenterB = vec2(
      0.5 + sin(uTime * 0.11 + 3.4) * 0.34,
      0.5 + cos(uTime * 0.19 + 0.4) * 0.2
    );
    vec2 roamingCenterC = vec2(
      0.5 + cos(uTime * 0.14 + 5.1) * 0.31,
      0.5 + sin(uTime * 0.16 + 1.2) * 0.22
    );
    vec2 cloudVectorA = (flowUv - roamingCenterA) * vec2(3.0, 5.5);
    vec2 cloudVectorB = (flowUv - roamingCenterB) * vec2(3.8, 6.2);
    vec2 cloudVectorC = (flowUv - roamingCenterC) * vec2(3.35, 5.8);
    float roamingCloudA = exp(-dot(cloudVectorA, cloudVectorA));
    float roamingCloudB = exp(-dot(cloudVectorB, cloudVectorB));
    float roamingCloudC = exp(-dot(cloudVectorC, cloudVectorC));
    float roamingDensity = roamingCloudA * 0.44 + roamingCloudB * 0.42 + roamingCloudC * 0.5;

    float colorFlowA = sin(flowUv.x * 4.8 + flowUv.y * 3.1 + uTime * 0.19) * 0.5 + 0.5;
    float colorFlowB = sin(-flowUv.x * 3.2 + flowUv.y * 5.4 - uTime * 0.14 + 2.0) * 0.5 + 0.5;
    float wholeFlow = mix(colorFlowA, colorFlowB, 0.38);
    vec3 mistColor = mix(vec3(0.925, 0.961, 0.976), vec3(0.91, 0.973, 0.965), wholeFlow * 0.42);
    mistColor = mix(mistColor, vec3(0.97, 0.985, 0.99), roamingCloudA * 0.52);
    mistColor = mix(mistColor, vec3(0.89, 0.93, 0.95), roamingCloudB * 0.38);
    mistColor = mix(mistColor, vec3(0.94, 0.98, 0.94), roamingCloudC * 0.5);

    vec4 ribbonA = auroraRibbon(vUv, uAuroraA, uAuroraMotionA, uAuroraRangeA);
    vec4 ribbonB = auroraRibbon(vUv, uAuroraB, uAuroraMotionB, uAuroraRangeB);
    vec4 ribbonC = auroraRibbon(vUv, uAuroraC, uAuroraMotionC, uAuroraRangeC);
    float auroraRegion = 1.0 - smoothstep(
      uAuroraBoundary - 0.1,
      uAuroraBoundary - 0.025,
      vUv.y
    );
    float auroraAlpha = (ribbonA.a + ribbonB.a + ribbonC.a) * edgeFade * auroraRegion;
    vec3 auroraColor = vec3(0.0);
    float colorWeight = 0.0;
    auroraColor += ribbonA.rgb * ribbonA.a;
    colorWeight += ribbonA.a;
    auroraColor += ribbonB.rgb * ribbonB.a;
    colorWeight += ribbonB.a;
    auroraColor += ribbonC.rgb * ribbonC.a;
    colorWeight += ribbonC.a;
    auroraColor /= max(colorWeight, 0.001);

    float ambientFlow = 0.026 + wholeFlow * 0.018;
    float alpha = (ambientFlow + roamingDensity * 0.058) * edgeFade + auroraAlpha * 0.8;
    vec3 finalColor = mix(mistColor, auroraColor, clamp(auroraAlpha * 1.65, 0.0, 0.76));
    gl_FragColor = vec4(finalColor, clamp(alpha, 0.0, 0.56));
  }
`;

type AuroraSlot = {
  age: number;
  baseIntensity: number;
  duration: number;
  motion: THREE.Vector4;
  range: THREE.Vector4;
  shape: THREE.Vector4;
};

function smoothStep(value: number) {
  const clampedValue = THREE.MathUtils.clamp(value, 0, 1);
  return clampedValue * clampedValue * (3 - 2 * clampedValue);
}

function createAuroraSlot() {
  return {
    age: 0,
    baseIntensity: 0,
    duration: 0,
    motion: new THREE.Vector4(),
    range: new THREE.Vector4(0, 1, 0, 0),
    shape: new THREE.Vector4(0.5, 0.1, 0, Math.random()),
  } satisfies AuroraSlot;
}

function spawnAurora(slot: AuroraSlot, initialProgress = 0) {
  const duration = 7.5 + Math.random() * 5.5;
  const isShortRibbon = Math.random() < 0.3;
  const ribbonLength = isShortRibbon ? 0.45 + Math.random() * 0.15 : 0.65 + Math.random() * 0.25;
  const ribbonStart = Math.random() * (1 - ribbonLength);
  const isAngledRibbon = Math.random() < 0.3;
  const angleDegrees = isAngledRibbon
    ? (3 + Math.random() * 4) * (Math.random() > 0.5 ? 1 : -1)
    : (Math.random() - 0.5) * 2;
  Object.assign(slot, {
    age: duration * initialProgress,
    baseIntensity: 0.8 + Math.random() * 0.15,
    duration,
  });
  slot.shape.set(0.16 + Math.random() * 0.28, 0.045 + Math.random() * 0.03, 0, Math.random());
  slot.range.set(
    ribbonStart,
    ribbonStart + ribbonLength,
    Math.tan(THREE.MathUtils.degToRad(angleDegrees)),
    0,
  );
  slot.motion.set(
    Math.random() * Math.PI * 2,
    (0.11 + Math.random() * 0.1) * (Math.random() > 0.5 ? 1 : -1),
    0.024 + Math.random() * 0.032,
    5.2 + Math.random() * 3.8,
  );
}

export default function WakeField() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return undefined;
    }

    const interactionElement = container.parentElement ?? container;
    let renderer: THREE.WebGLRenderer;

    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
      });
    } catch {
      return undefined;
    }

    renderer.setClearColor(0xffffff, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'wake-field-canvas';
    container.append(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0.1, 10);
    camera.position.z = 4;

    const auroraSlots = [createAuroraSlot(), createAuroraSlot(), createAuroraSlot()];
    spawnAurora(auroraSlots[0], 0.22);
    spawnAurora(auroraSlots[1], 0.54);

    const backgroundUniforms = {
      uTime: { value: 1.8 },
      uAuroraA: { value: auroraSlots[0].shape },
      uAuroraB: { value: auroraSlots[1].shape },
      uAuroraC: { value: auroraSlots[2].shape },
      uAuroraMotionA: { value: auroraSlots[0].motion },
      uAuroraMotionB: { value: auroraSlots[1].motion },
      uAuroraMotionC: { value: auroraSlots[2].motion },
      uAuroraRangeA: { value: auroraSlots[0].range },
      uAuroraRangeB: { value: auroraSlots[1].range },
      uAuroraRangeC: { value: auroraSlots[2].range },
      uAuroraAspect: { value: 1 },
      uAuroraBoundary: { value: 0.5 },
    };
    const backgroundGeometry = new THREE.PlaneGeometry(1, 1);
    const backgroundMaterial = new THREE.ShaderMaterial({
      depthWrite: false,
      fragmentShader: backgroundFragmentShader,
      side: THREE.DoubleSide,
      transparent: true,
      uniforms: backgroundUniforms,
      vertexShader: backgroundVertexShader,
    });
    const backgroundPlane = new THREE.Mesh(backgroundGeometry, backgroundMaterial);
    backgroundPlane.position.z = -0.08;
    scene.add(backgroundPlane);

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animationFrame = 0;
    let lastTimestamp = 0;
    let isIntersecting = true;
    let hasRendered = false;
    let elapsed = 1.8;
    let nextAuroraDelay = 2.2 + Math.random() * 1.8;

    const updateAuroras = (delta: number) => {
      nextAuroraDelay -= delta;

      for (const slot of auroraSlots) {
        if (slot.duration <= 0) {
          slot.shape.z = 0;
          continue;
        }

        slot.age += delta;

        if (slot.age >= slot.duration) {
          slot.duration = 0;
          slot.shape.z = 0;
          continue;
        }

        const progress = slot.age / slot.duration;
        const fadeIn = smoothStep(progress / 0.2);
        const fadeOut = 1 - smoothStep((progress - 0.62) / 0.38);
        const breathing = 0.92 + Math.sin(elapsed * 0.72 + slot.shape.w * 10) * 0.08;
        slot.shape.z = slot.baseIntensity * fadeIn * fadeOut * breathing;
      }

      if (nextAuroraDelay <= 0) {
        const availableSlot = auroraSlots.find((slot) => slot.duration <= 0);

        if (availableSlot) {
          spawnAurora(availableSlot);
          nextAuroraDelay = 2.8 + Math.random() * 2.6;
        } else {
          nextAuroraDelay = 0.8;
        }
      }
    };

    const resize = () => {
      const bounds = container.getBoundingClientRect();
      const interactionBounds = interactionElement.getBoundingClientRect();
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      const visiblePlaneWidth = Math.min(width, interactionBounds.width);
      const visiblePlaneHeight = Math.min(height, interactionBounds.height);
      const visiblePlaneTop = bounds.top + (height - visiblePlaneHeight) / 2;
      const composer = interactionElement.querySelector('.composer');
      const composerTop = composer?.getBoundingClientRect().top ?? interactionBounds.top;
      camera.left = 0;
      camera.right = width;
      camera.top = 0;
      camera.bottom = height;
      camera.updateProjectionMatrix();
      backgroundPlane.position.set(width / 2, height / 2, -0.08);
      backgroundPlane.scale.set(visiblePlaneWidth, visiblePlaneHeight, 1);
      backgroundUniforms.uAuroraAspect.value = visiblePlaneWidth / visiblePlaneHeight;
      backgroundUniforms.uAuroraBoundary.value = THREE.MathUtils.clamp(
        (composerTop - visiblePlaneTop) / visiblePlaneHeight,
        0.2,
        0.8,
      );
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDevicePixelRatio));
      renderer.setSize(width, height, false);
      renderer.render(scene, camera);
    };

    const renderFrame = (timestamp: number) => {
      animationFrame = window.requestAnimationFrame(renderFrame);

      if (document.hidden || !isIntersecting || timestamp - lastTimestamp < targetFrameDuration) {
        return;
      }

      const delta = lastTimestamp === 0 ? 0 : Math.min((timestamp - lastTimestamp) / 1000, 0.08);
      lastTimestamp = timestamp;

      if (!reducedMotion.matches) {
        elapsed += delta;
        updateAuroras(delta);
      }

      backgroundUniforms.uTime.value = elapsed;
      renderer.render(scene, camera);

      if (!hasRendered) {
        hasRendered = true;
        container.classList.add('is-ready');
      }
    };

    const resizeObserver = new ResizeObserver(resize);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      isIntersecting = entry.isIntersecting;
      lastTimestamp = 0;
    });

    resizeObserver.observe(container);
    intersectionObserver.observe(container);
    resize();
    animationFrame = window.requestAnimationFrame(renderFrame);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      backgroundGeometry.dispose();
      backgroundMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div className='wake-field' ref={containerRef} aria-hidden='true'>
      <div className='wake-field-fallback' />
    </div>
  );
}
