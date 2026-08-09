import { useEffect, useRef } from 'react';
import * as THREE from 'three';

const maxParticles = 2800;
const targetFrameDuration = 1000 / 45;
const maxDevicePixelRatio = 1.5;

const particleVertexShader = /* glsl */ `
  uniform float uPixelRatio;

  attribute float aAlpha;
  attribute float aAngle;
  attribute float aKind;
  attribute float aSeed;
  attribute float aSize;

  varying float vAlpha;
  varying float vAngle;
  varying float vKind;
  varying float vSeed;
  varying vec3 vColor;

  void main() {
    vAlpha = aAlpha;
    vAngle = aAngle;
    vKind = aKind;
    vSeed = aSeed;
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio;
  }
`;

const particleFragmentShader = /* glsl */ `
  varying float vAlpha;
  varying float vAngle;
  varying float vKind;
  varying float vSeed;
  varying vec3 vColor;

  void main() {
    vec2 point = gl_PointCoord - 0.5;
    float distanceToCenter = length(point);
    float angle = atan(point.y, point.x);
    float angleCosine = cos(vAngle);
    float angleSine = sin(vAngle);
    vec2 localPoint = vec2(
      angleCosine * point.x + angleSine * point.y,
      -angleSine * point.x + angleCosine * point.y
    );
    float irregularity = sin(angle * 5.0 + vSeed * 8.0) * 0.022;
    irregularity += sin((point.x * 17.0 + point.y * 13.0 + vSeed) * 4.0) * 0.012;
    float softCloud = 1.0 - smoothstep(0.12, 0.49 + irregularity, distanceToCenter);
    float jetAxis = localPoint.x + 0.035;
    float widthNoise = sin(jetAxis * 22.0 + vSeed * 9.0) * 0.5;
    widthNoise += sin(jetAxis * 49.0 - vSeed * 13.0) * 0.22;
    float jetHalfWidth = 0.058 + (widthNoise * 0.5 + 0.5) * 0.052;
    float jetLength = 1.0 - smoothstep(0.36, 0.5, abs(jetAxis));
    float jetCrossSection = 1.0 - smoothstep(jetHalfWidth * 0.42, jetHalfWidth, abs(localPoint.y));
    float jetWisp = jetLength * jetCrossSection;
    float filamentCrossSection = 1.0 - smoothstep(
      jetHalfWidth * 0.12,
      jetHalfWidth * 0.4,
      abs(localPoint.y)
    );
    float jetFilament = jetLength * filamentCrossSection;
    float brightCore = 1.0 - smoothstep(0.06, 0.46, distanceToCenter);
    float pulseDistance = length(vec2(localPoint.x * 0.78, localPoint.y * 1.3));
    float pressureRing = 1.0 - smoothstep(0.035, 0.11, abs(pulseDistance - 0.32));
    float pressureOpening = mix(0.32, 1.0, smoothstep(-0.34, 0.36, localPoint.x));
    float shape = softCloud * softCloud;

    if (vKind > 0.5 && vKind < 1.5) {
      shape = max(jetWisp * jetWisp, jetFilament * 0.88);
    } else if (vKind >= 1.5 && vKind < 2.5) {
      shape = brightCore * brightCore;
    } else if (vKind >= 2.5) {
      shape = pressureRing * pressureOpening;
    }

    if (shape <= 0.001) {
      discard;
    }

    gl_FragColor = vec4(vColor, shape * vAlpha);
  }
`;

const backgroundVertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const backgroundFragmentShader = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;

  void main() {
    float edgeX = smoothstep(0.0, 0.15, vUv.x) * smoothstep(0.0, 0.15, 1.0 - vUv.x);
    float edgeY = smoothstep(0.0, 0.18, vUv.y) * smoothstep(0.0, 0.18, 1.0 - vUv.y);
    float edgeFade = edgeX * edgeY;

    float centerA = 0.52 + sin(vUv.x * 6.2 + uTime * 0.28) * 0.035;
    float centerB = 0.49 + sin(vUv.x * 9.0 - uTime * 0.2 + 1.7) * 0.055;
    float bandA = exp(-pow((vUv.y - centerA) * 8.5, 2.0));
    float bandB = exp(-pow((vUv.y - centerB) * 13.0, 2.0));
    float airNoise = sin(vUv.x * 18.0 + vUv.y * 7.0 + uTime * 0.22) * 0.5 + 0.5;
    float density = bandA * 0.58 + bandB * 0.25 + airNoise * bandA * 0.12;

    vec2 roamingCenterA = vec2(
      0.5 + sin(uTime * 0.17 + 0.8) * 0.29,
      0.51 + sin(uTime * 0.23 + 2.1) * 0.17
    );
    vec2 roamingCenterB = vec2(
      0.5 + sin(uTime * 0.11 + 3.4) * 0.34,
      0.5 + cos(uTime * 0.19 + 0.4) * 0.2
    );
    vec2 cloudVectorA = (vUv - roamingCenterA) * vec2(3.0, 5.5);
    vec2 cloudVectorB = (vUv - roamingCenterB) * vec2(3.8, 6.2);
    float roamingCloudA = exp(-dot(cloudVectorA, cloudVectorA));
    float roamingCloudB = exp(-dot(cloudVectorB, cloudVectorB));
    float roamingDensity = roamingCloudA * 0.68 + roamingCloudB * 0.48;

    float colorFlow = sin(vUv.x * 5.4 - vUv.y * 3.2 + uTime * 0.3) * 0.5 + 0.5;
    float colorDensity = clamp(
      roamingCloudA * 0.88 + roamingCloudB * 0.72 + density * 0.12,
      0.0,
      1.0
    );
    vec3 mistColor = mix(vec3(0.91, 0.96, 1.0), vec3(0.68, 0.85, 1.0), colorDensity);
    mistColor = mix(
      mistColor,
      vec3(0.75, 0.89, 1.0),
      colorFlow * (0.07 + roamingCloudB * 0.13)
    );
    float alpha = (density * 0.128 + roamingDensity * 0.074) * edgeFade;
    gl_FragColor = vec4(mistColor, alpha);
  }
`;

type ParticleKind = 0 | 1 | 2 | 3;

type Particle = {
  active: boolean;
  alpha: number;
  angle: number;
  curl: number;
  kind: ParticleKind;
  life: number;
  maxLife: number;
  seed: number;
  size: number;
  velocityX: number;
  velocityY: number;
  x: number;
  y: number;
};

function getParticleAppearance(kind: ParticleKind, speedFactor: number) {
  switch (kind) {
    case 0:
      return {
        alpha: 0.115 + Math.random() * 0.065,
        curlRange: 1.15,
        jitter: 5,
        maxLife: 1.2 + Math.random() * 0.95 + speedFactor * 0.7,
        size: 22 + Math.random() * 26 + speedFactor * 34,
      };
    case 1:
      return {
        alpha: 0.16 + Math.random() * 0.075,
        curlRange: 0.5,
        jitter: 3,
        maxLife: 1.05 + Math.random() * 0.65 + speedFactor * 0.55,
        size: 7 + Math.random() * 8 + speedFactor * 16,
      };
    case 2:
      return {
        alpha: 0.18 + Math.random() * 0.08,
        curlRange: 0.5,
        jitter: 3,
        maxLife: 0.4 + Math.random() * 0.28 + speedFactor * 0.22,
        size: 4 + Math.random() * 5 + speedFactor * 5,
      };
    case 3:
      return {
        alpha: 0.08 + Math.random() * 0.045,
        curlRange: 0.08,
        jitter: 3,
        maxLife: 0.58 + Math.random() * 0.3 + speedFactor * 0.28,
        size: 22 + Math.random() * 14 + speedFactor * 24,
      };
  }
}

function getParticleExpansion(kind: ParticleKind) {
  switch (kind) {
    case 0:
      return 1.15;
    case 1:
      return 0.48;
    case 2:
      return 0.22;
    case 3:
      return 1.05;
  }
}

function getParticleDamping(kind: ParticleKind) {
  switch (kind) {
    case 0:
      return 0.975;
    case 1:
      return 0.968;
    case 2:
      return 0.955;
    case 3:
      return 0.98;
  }
}

function getParticleColor(kind: ParticleKind): readonly [number, number, number] {
  switch (kind) {
    case 0:
      return [0.56, 0.66, 0.82];
    case 1:
      return [0.22, 0.29, 0.58];
    case 2:
      return [0.25, 0.38, 0.72];
    case 3:
      return [0.42, 0.52, 0.72];
  }
}

function createParticles(): Particle[] {
  return Array.from({ length: maxParticles }, () => ({
    active: false,
    alpha: 0,
    angle: 0,
    curl: 0,
    kind: 0,
    life: 0,
    maxLife: 1,
    seed: 0,
    size: 1,
    velocityX: 0,
    velocityY: 0,
    x: 0,
    y: 0,
  }));
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

    const backgroundUniforms = {
      uTime: { value: 1.8 },
    };
    const backgroundGeometry = new THREE.PlaneGeometry(1, 1);
    const backgroundMaterial = new THREE.ShaderMaterial({
      depthWrite: false,
      fragmentShader: backgroundFragmentShader,
      transparent: true,
      uniforms: backgroundUniforms,
      vertexShader: backgroundVertexShader,
    });
    const backgroundPlane = new THREE.Mesh(backgroundGeometry, backgroundMaterial);
    backgroundPlane.position.z = -0.08;
    scene.add(backgroundPlane);

    const particlePositions = new Float32Array(maxParticles * 3);
    const particleColors = new Float32Array(maxParticles * 3);
    const particleSizes = new Float32Array(maxParticles);
    const particleAlphas = new Float32Array(maxParticles);
    const particleAngles = new Float32Array(maxParticles);
    const particleSeeds = new Float32Array(maxParticles);
    const particleKinds = new Float32Array(maxParticles);
    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    particleGeometry.setAttribute('color', new THREE.BufferAttribute(particleColors, 3));
    particleGeometry.setAttribute('aSize', new THREE.BufferAttribute(particleSizes, 1));
    particleGeometry.setAttribute('aAlpha', new THREE.BufferAttribute(particleAlphas, 1));
    particleGeometry.setAttribute('aAngle', new THREE.BufferAttribute(particleAngles, 1));
    particleGeometry.setAttribute('aSeed', new THREE.BufferAttribute(particleSeeds, 1));
    particleGeometry.setAttribute('aKind', new THREE.BufferAttribute(particleKinds, 1));

    const particleUniforms = {
      uPixelRatio: { value: 1 },
    };
    const particleMaterial = new THREE.ShaderMaterial({
      blending: THREE.NormalBlending,
      depthWrite: false,
      fragmentShader: particleFragmentShader,
      transparent: true,
      uniforms: particleUniforms,
      vertexColors: true,
      vertexShader: particleVertexShader,
    });
    const particlePoints = new THREE.Points(particleGeometry, particleMaterial);
    particlePoints.frustumCulled = false;
    scene.add(particlePoints);

    const particles = createParticles();
    const freeParticleIndices = Array.from(
      { length: particles.length },
      (_, index) => particles.length - index - 1,
    );
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let width = 1;
    let height = 1;
    let overflowCursor = 0;
    let animationFrame = 0;
    let lastTimestamp = 0;
    let isIntersecting = true;
    let pointerInside = false;
    let previousPointerX = 0;
    let previousPointerY = 0;
    let previousPointerTime = 0;
    let hasRendered = false;
    let elapsed = 1.8;

    const activateParticle = (
      x: number,
      y: number,
      velocityX: number,
      velocityY: number,
      speed: number,
      kind: ParticleKind,
      angle: number,
    ) => {
      const freeParticleIndex = freeParticleIndices.pop();
      const particleIndex = freeParticleIndex ?? overflowCursor;
      const particle = particles[particleIndex];

      if (freeParticleIndex === undefined) {
        overflowCursor = (overflowCursor + 1) % particles.length;
      }

      const speedFactor = THREE.MathUtils.clamp((speed - 70) / 1000, 0, 1);
      const appearance = getParticleAppearance(kind, speedFactor);
      particle.active = true;
      particle.alpha = appearance.alpha * (0.45 + speedFactor * 0.55);
      particle.angle = angle;
      particle.curl = (Math.random() - 0.5) * appearance.curlRange;
      particle.kind = kind;
      particle.life = appearance.maxLife;
      particle.maxLife = appearance.maxLife;
      particle.seed = Math.random();
      particle.size = appearance.size;
      particle.velocityX = velocityX + (Math.random() - 0.5) * appearance.jitter;
      particle.velocityY = velocityY + (Math.random() - 0.5) * appearance.jitter;
      particle.x = x;
      particle.y = y;
    };

    const emitJet = (
      x: number,
      y: number,
      directionX: number,
      directionY: number,
      speed: number,
    ) => {
      const normalX = -directionY;
      const normalY = directionX;
      const power = THREE.MathUtils.clamp((speed - 70) / 1000, 0, 1);
      const thrust = 7 + power * 82;
      const spawnAhead = 2 + power * 10;
      const lateralDrift = (Math.random() - 0.5) * (2 + power * 4);
      const jetAngle = Math.atan2(directionY, directionX);

      activateParticle(
        x + directionX * spawnAhead,
        y + directionY * spawnAhead,
        directionX * thrust * 0.66 + normalX * lateralDrift,
        directionY * thrust * 0.66 + normalY * lateralDrift,
        speed,
        0,
        jetAngle,
      );
      activateParticle(
        x + directionX * (spawnAhead + 2),
        y + directionY * (spawnAhead + 2),
        directionX * thrust,
        directionY * thrust,
        speed,
        1,
        jetAngle,
      );
      activateParticle(
        x + directionX * (spawnAhead + 3),
        y + directionY * (spawnAhead + 3),
        directionX * thrust * 1.14,
        directionY * thrust * 1.14,
        speed,
        2,
        jetAngle,
      );

      if (Math.random() < 0.025 + power * 0.17) {
        activateParticle(
          x + directionX * (spawnAhead + 4),
          y + directionY * (spawnAhead + 4),
          directionX * thrust * 0.3,
          directionY * thrust * 0.3,
          speed,
          3,
          jetAngle,
        );
      }
    };

    const updateParticles = (delta: number) => {
      for (let index = 0; index < particles.length; index += 1) {
        const particle = particles[index];
        const positionIndex = index * 3;

        if (!particle.active) {
          particleAlphas[index] = 0;
          continue;
        }

        particle.life -= delta;

        if (particle.life <= 0) {
          particle.active = false;
          particleAlphas[index] = 0;
          freeParticleIndices.push(index);
          continue;
        }

        const rotation = particle.curl * delta;
        const cosine = Math.cos(rotation);
        const sine = Math.sin(rotation);
        const nextVelocityX = particle.velocityX * cosine - particle.velocityY * sine;
        const nextVelocityY = particle.velocityX * sine + particle.velocityY * cosine;
        const damping = Math.pow(getParticleDamping(particle.kind), delta * 60);
        particle.velocityX = nextVelocityX * damping;
        particle.velocityY = nextVelocityY * damping;
        if (particle.kind === 1) {
          particle.angle = Math.atan2(particle.velocityY, particle.velocityX);
        }
        particle.x += particle.velocityX * delta;
        particle.y += particle.velocityY * delta;

        const lifeProgress = particle.life / particle.maxLife;
        const fadeIn = THREE.MathUtils.clamp((1 - lifeProgress) * 6, 0, 1);
        const fadeOut = THREE.MathUtils.smoothstep(lifeProgress, 0, 0.58);
        particlePositions[positionIndex] = particle.x;
        particlePositions[positionIndex + 1] = particle.y;
        particlePositions[positionIndex + 2] = particle.kind === 0 ? 0 : 0.02;
        const expansion = getParticleExpansion(particle.kind);
        particleSizes[index] = particle.size * (1 + (1 - lifeProgress) * expansion);
        particleAlphas[index] = particle.alpha * fadeOut * fadeIn;
        particleAngles[index] = particle.angle;
        particleSeeds[index] = particle.seed;
        particleKinds[index] = particle.kind;

        const particleColor = getParticleColor(particle.kind);
        particleColors[positionIndex] = particleColor[0];
        particleColors[positionIndex + 1] = particleColor[1];
        particleColors[positionIndex + 2] = particleColor[2];
      }

      for (const attributeName of [
        'position',
        'color',
        'aSize',
        'aAlpha',
        'aAngle',
        'aSeed',
        'aKind',
      ]) {
        const attribute = particleGeometry.getAttribute(attributeName);
        attribute.needsUpdate = true;
      }
    };

    const resize = () => {
      const bounds = container.getBoundingClientRect();
      const interactionBounds = interactionElement.getBoundingClientRect();
      const containerStyles = window.getComputedStyle(container);
      const visibleOverflowX =
        Number.parseFloat(containerStyles.getPropertyValue('--wake-visible-overflow-x')) || 0;
      const visibleOverflowY =
        Number.parseFloat(containerStyles.getPropertyValue('--wake-visible-overflow-y')) || 0;
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      camera.left = 0;
      camera.right = width;
      camera.top = 0;
      camera.bottom = height;
      camera.updateProjectionMatrix();
      backgroundPlane.position.set(width / 2, height / 2, -0.08);
      backgroundPlane.scale.set(
        Math.min(width, interactionBounds.width + visibleOverflowX * 2),
        Math.min(height, interactionBounds.height + visibleOverflowY * 2),
        1,
      );
      const pixelRatio = Math.min(window.devicePixelRatio || 1, maxDevicePixelRatio);
      particleUniforms.uPixelRatio.value = pixelRatio;
      renderer.setPixelRatio(pixelRatio);
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
      }

      backgroundUniforms.uTime.value = elapsed;

      if (!reducedMotion.matches) {
        updateParticles(delta);
      }

      renderer.render(scene, camera);

      if (!hasRendered) {
        hasRendered = true;
        container.classList.add('is-ready');
      }
    };

    const startInteraction = (event: PointerEvent) => {
      const bounds = container.getBoundingClientRect();
      pointerInside = true;
      previousPointerX = event.clientX - bounds.left;
      previousPointerY = event.clientY - bounds.top;
      previousPointerTime = performance.now();
    };
    const pressField = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.composer-dock')) {
        pointerInside = false;
        return;
      }

      startInteraction(event);
      interactionElement.setPointerCapture(event.pointerId);
    };
    const moveThroughField = (event: PointerEvent) => {
      if (reducedMotion.matches) {
        return;
      }

      if (event.target instanceof Element && event.target.closest('.composer-dock')) {
        pointerInside = false;
        return;
      }

      if (!pointerInside) {
        startInteraction(event);
        return;
      }

      const bounds = container.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const nowMilliseconds = performance.now();
      const deltaX = x - previousPointerX;
      const deltaY = y - previousPointerY;
      const distance = Math.hypot(deltaX, deltaY);
      const deltaSeconds = Math.max((nowMilliseconds - previousPointerTime) / 1000, 0.008);

      if (distance >= 1.5) {
        const directionX = deltaX / distance;
        const directionY = deltaY / distance;
        const speed = distance / deltaSeconds;
        const steps = Math.min(8, Math.max(1, Math.ceil(distance / 8)));

        for (let step = 1; step <= steps; step += 1) {
          const progress = step / steps;
          emitJet(
            previousPointerX + deltaX * progress,
            previousPointerY + deltaY * progress,
            directionX,
            directionY,
            speed,
          );
        }
      }

      previousPointerX = x;
      previousPointerY = y;
      previousPointerTime = nowMilliseconds;
    };
    const leaveField = () => {
      pointerInside = false;
    };

    const resizeObserver = new ResizeObserver(resize);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      isIntersecting = entry.isIntersecting;
      lastTimestamp = 0;
    });

    resizeObserver.observe(container);
    intersectionObserver.observe(container);
    interactionElement.addEventListener('pointerenter', startInteraction);
    interactionElement.addEventListener('pointerdown', pressField);
    interactionElement.addEventListener('pointermove', moveThroughField, { passive: true });
    interactionElement.addEventListener('pointerleave', leaveField);
    interactionElement.addEventListener('pointerup', leaveField);
    interactionElement.addEventListener('pointercancel', leaveField);
    resize();
    animationFrame = window.requestAnimationFrame(renderFrame);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      interactionElement.removeEventListener('pointerenter', startInteraction);
      interactionElement.removeEventListener('pointerdown', pressField);
      interactionElement.removeEventListener('pointermove', moveThroughField);
      interactionElement.removeEventListener('pointerleave', leaveField);
      interactionElement.removeEventListener('pointerup', leaveField);
      interactionElement.removeEventListener('pointercancel', leaveField);
      backgroundGeometry.dispose();
      backgroundMaterial.dispose();
      particleGeometry.dispose();
      particleMaterial.dispose();
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
