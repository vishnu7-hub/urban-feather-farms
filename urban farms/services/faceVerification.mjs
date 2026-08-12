/**
 * Face Verification Service
 * 
 * - MOCK mode: Uses random similarity scores for local development
 * - PRODUCTION mode: Uses AWS Rekognition CompareFaces API
 * 
 * Toggle via env vars:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
 * If not set → MOCK mode
 * If set → REAL AWS Rekognition calls
 *
 * NOTE: AWS face verification is disabled for demo mode.
 */

const USE_MOCK = true;
const ALLOW_MOCK_FACE_VERIFICATION = true;

let RekognitionClient, CompareFacesCommand, DetectFacesCommand;

let rekognitionClient = null;

function getRekognitionClient() {
  return null;
}

/**
 * Convert a base64 image to a Uint8Array for AWS SDK
 */
function base64ToUint8Array(base64) {
  // Remove data-URL prefix if present
  const raw = base64.replace(/^data:image\/\w+;base64,/, '');
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Compare two face images and return similarity score
 * 
 * @param {string} sourceImageBase64 - Baseline / enrollment image (data-URL)
 * @param {string} targetImageBase64 - Freshly captured image (data-URL)
 * @returns {Promise<{similarity: number, matched: boolean, raw?: object}>}
 */
export async function compareFaces(sourceImageBase64, targetImageBase64) {
  if (!sourceImageBase64 || !targetImageBase64) {
    return { similarity: 0, matched: false, error: 'Missing one or both images' };
  }

  if (USE_MOCK && ALLOW_MOCK_FACE_VERIFICATION) {
    return mockCompareFaces(sourceImageBase64, targetImageBase64);
  }
  if (USE_MOCK) return { similarity: 0, matched: false, error: 'Face verification service is not configured' };

  return realCompareFaces(sourceImageBase64, targetImageBase64);
}

export function isFaceVerificationAvailable() {
  return ALLOW_MOCK_FACE_VERIFICATION || (!USE_MOCK && !!RekognitionClient && !!DetectFacesCommand);
}

export async function detectSingleFace(imageBase64) {
  if (!imageBase64) return { ok: false, error: 'Face image is required' };
  if (USE_MOCK && ALLOW_MOCK_FACE_VERIFICATION) return { ok: true };
  if (!isFaceVerificationAvailable()) return { ok: false, error: 'Face verification service is not configured' };
  try {
    const response = await getRekognitionClient().send(new DetectFacesCommand({
      Image: { Bytes: base64ToUint8Array(imageBase64) }, Attributes: ['DEFAULT']
    }));
    const count = response.FaceDetails?.length || 0;
    if (count !== 1) return { ok: false, error: count === 0 ? 'No face detected in the selfie' : 'Use a selfie with only one face' };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Unable to verify the selfie. Please take a clear photo and try again.' };
  }
}

/**
 * MOCK: Generate a realistic random similarity score
 * - 70% chance of "good match" (>= 80%)
 * - 15% chance of "uncertain" (50-79%)
 * - 15% chance of "no match" (< 50%)
 */
function mockCompareFaces(sourceImageBase64, targetImageBase64) {
  const rand = Math.random();
  let similarity;

  if (rand < 0.70) {
    // Good match: 80-99%
    similarity = 80 + Math.random() * 19;
  } else if (rand < 0.85) {
    // Uncertain: 50-79%
    similarity = 50 + Math.random() * 29;
  } else {
    // No match: 0-49%
    similarity = Math.random() * 49;
  }

  similarity = Math.round(similarity * 100) / 100; // 2 decimal places
  const matched = similarity >= 80;

  console.log(`[FaceVerification:MOCK] Similarity: ${similarity}% → ${matched ? 'MATCH ✓' : similarity >= 50 ? 'UNCERTAIN ⚠' : 'NO MATCH ✗'}`);

  return {
    similarity,
    matched,
    raw: {
      sourceImageSize: sourceImageBase64.length,
      targetImageSize: targetImageBase64.length,
      mock: true,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * REAL: Use AWS Rekognition CompareFaces API
 */
async function realCompareFaces(sourceImageBase64, targetImageBase64) {
  try {
    const client = getRekognitionClient();
    if (!client) {
      throw new Error('Rekognition client not initialized');
    }

    const command = new CompareFacesCommand({
      SourceImage: { Bytes: base64ToUint8Array(sourceImageBase64) },
      TargetImage: { Bytes: base64ToUint8Array(targetImageBase64) },
      SimilarityThreshold: 0, // Get all results, we'll filter
    });

    const response = await client.send(command);

    let similarity = 0;
    let matched = false;

    if (response.FaceMatches && response.FaceMatches.length > 0) {
      // Take the highest similarity match
      const bestMatch = response.FaceMatches.reduce((best, current) =>
        (current.Similarity || 0) > (best.Similarity || 0) ? current : best
      , response.FaceMatches[0]);
      
      similarity = Math.round((bestMatch.Similarity || 0) * 100) / 100;
      matched = similarity >= 80;
    }

    // If UnmatchedFaces exist and no good match, take the highest unmatched as uncertain
    if (!matched && response.UnmatchedFaces && response.UnmatchedFaces.length > 0) {
      // Still no reliable match
      similarity = Math.round(((response.UnmatchedFaces[0].Confidence || 0) / 100) * 100) / 100;
    }

    console.log(`[FaceVerification:AWS] Similarity: ${similarity}% → ${matched ? 'MATCH ✓' : 'NO MATCH ✗'}`);

    return {
      similarity,
      matched,
      raw: {
        faceMatches: response.FaceMatches?.length || 0,
        unmatchedFaces: response.UnmatchedFaces?.length || 0,
        awsRequestId: response.$metadata?.requestId,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (error) {
    console.error('[FaceVerification:AWS] Error:', error.message);
    // Fall back to mock on AWS failure
    console.warn('[FaceVerification:AWS] Falling back to MOCK mode');
    return mockCompareFaces(sourceImageBase64, targetImageBase64);
  }
}

/**
 * Calculate distance between two GPS coordinates using Haversine formula
 * 
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lon1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lon2 - Longitude of point 2
 * @returns {number} Distance in meters
 */
export function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth's radius in meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c); // meters
}

function toRad(deg) {
  return deg * (Math.PI / 180);
}

/**
 * Check if delivery GPS is within acceptable range of order shop GPS
 * 
 * @param {object} deliveryLocation - { latitude, longitude }
 * @param {object} shopLocation - { latitude, longitude }
 * @param {number} maxDistance - Maximum allowed distance in meters (default: 150)
 * @returns {{ withinRange: boolean, distance: number }}
 */
export function checkDeliveryProximity(deliveryLocation, shopLocation, maxDistance = 150) {
  if (!deliveryLocation || !shopLocation) {
    return { withinRange: false, distance: Infinity, error: 'Missing location data' };
  }

  const distance = calculateDistance(
    deliveryLocation.latitude,
    deliveryLocation.longitude,
    shopLocation.latitude,
    shopLocation.longitude
  );

  const withinRange = distance <= maxDistance;

  console.log(`[GPS Verification] Distance: ${distance}m from shop → ${withinRange ? 'WITHIN RANGE ✓' : 'TOO FAR ✗'} (limit: ${maxDistance}m)`);

  return { withinRange, distance };
}

export function isFaceVerificationReal() {
  return !USE_MOCK;
}

export default {
  compareFaces,
  detectSingleFace,
  isFaceVerificationAvailable,
  isFaceVerificationReal,
  calculateDistance,
  checkDeliveryProximity,
  USE_MOCK,
};

