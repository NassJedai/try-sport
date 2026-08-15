/**
 * Identification d'une image par son contenu, pas par ce que le client déclare.
 *
 * Le Content-Type d'une requête est une déclaration, pas une preuve : accepter
 * « image/jpeg » sur parole, c'est stocker n'importe quel fichier — y compris un
 * HTML qui, servi depuis notre domaine, devient un vecteur XSS. On lit donc les
 * octets magiques, et les dimensions directement dans les en-têtes du format.
 *
 * Fait à la main plutôt qu'avec une bibliothèque (sharp, image-size) : trois
 * formats suffisent, la surface d'analyse est minuscule et connue, et sharp est
 * une dépendance native lourde qui compliquerait chaque déploiement. Le jour où
 * il faudra générer des variantes (miniatures, WebP), ce sera le travail d'un
 * CDN d'images en aval — pas du serveur d'API.
 */

export interface ProbedImage {
  format: 'jpeg' | 'png' | 'webp';
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  extension: 'jpg' | 'png' | 'webp';
  width: number;
  height: number;
}

/** Une photo d'intérieur de salle dépasse rarement 5 Mo ; 8 laisse de la marge. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Garde-fou : personne n'affiche du 30 000 px, mais un décodeur peut en mourir. */
const MAX_DIMENSION = 12_000;

export function probeImage(buffer: Buffer): ProbedImage | null {
  const probed = probePng(buffer) ?? probeJpeg(buffer) ?? probeWebp(buffer);
  if (!probed) return null;

  if (
    probed.width < 1 ||
    probed.height < 1 ||
    probed.width > MAX_DIMENSION ||
    probed.height > MAX_DIMENSION
  ) {
    return null;
  }

  return probed;
}

/** PNG : signature de 8 octets, puis IHDR à position fixe — le cas facile. */
function probePng(buffer: Buffer): ProbedImage | null {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  // Le premier chunk d'un PNG valide est obligatoirement IHDR.
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;

  return {
    format: 'png',
    contentType: 'image/png',
    extension: 'png',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

/**
 * JPEG : les dimensions vivent dans un marqueur SOF dont la position varie —
 * il faut sauter les segments (EXIF, miniatures…) jusqu'à le trouver.
 */
function probeJpeg(buffer: Buffer): ProbedImage | null {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;

  let offset = 2;
  // Borne de sécurité : un fichier corrompu ne doit pas faire boucler le serveur.
  for (let guard = 0; guard < 1_000 && offset + 9 < buffer.length; guard += 1) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1]!;

    // SOF0..SOF15, en excluant DHT (C4), DNL (C8) et DAC (CC) qui ne sont pas
    // des « start of frame » malgré leur plage.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        format: 'jpeg',
        contentType: 'image/jpeg',
        extension: 'jpg',
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + buffer.readUInt16BE(offset + 2);
  }

  return null;
}

/** WebP : conteneur RIFF, trois variantes d'en-tête (VP8, VP8L, VP8X). */
function probeWebp(buffer: Buffer): ProbedImage | null {
  if (buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }

  const chunk = buffer.toString('ascii', 12, 16);
  const base = { format: 'webp' as const, contentType: 'image/webp' as const, extension: 'webp' as const };

  if (chunk === 'VP8 ') {
    // Flux avec perte : dimensions sur 14 bits à l'offset 26.
    return {
      ...base,
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }

  if (chunk === 'VP8L') {
    // Sans perte : 28 bits serrés après l'octet de signature 0x2f.
    if (buffer[20] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(21);
    return {
      ...base,
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  if (chunk === 'VP8X') {
    // Conteneur étendu : « canvas size » sur 24 bits, moins un.
    return {
      ...base,
      width: (buffer.readUIntLE(24, 3) & 0xffffff) + 1,
      height: (buffer.readUIntLE(27, 3) & 0xffffff) + 1,
    };
  }

  return null;
}
