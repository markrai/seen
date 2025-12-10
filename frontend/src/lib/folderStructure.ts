/**
 * Extracts year and month from a file path based on common folder structure patterns.
 * Recognizes patterns like:
 * - /2025/01/image.jpg (year/month)
 * - /2025/1/image.jpg (year/month)
 * - /2025/January/image.jpg (year/month)
 * - /2025/Jan/image.jpg (year/month)
 * - /2025/image.jpg (year only - uses month 1 as default)
 * 
 * @param path - The file path to parse
 * @returns Object with year and month (1-12) if found, null otherwise
 */
export function extractYearMonthFromPath(path: string): { year: number; month: number } | null {
  if (!path) return null;

  // Normalize path separators (handle both / and \)
  const normalizedPath = path.replace(/\\/g, '/');
  
  // Split path into segments
  const segments = normalizedPath.split('/').filter(segment => segment.length > 0);
  
  if (segments.length < 2) return null;

  // Month name mappings (case-insensitive)
  const monthNames: Record<string, number> = {
    'january': 1, 'jan': 1,
    'february': 2, 'feb': 2,
    'march': 3, 'mar': 3,
    'april': 4, 'apr': 4,
    'may': 5,
    'june': 6, 'jun': 6,
    'july': 7, 'jul': 7,
    'august': 8, 'aug': 8,
    'september': 9, 'sep': 9, 'sept': 9,
    'october': 10, 'oct': 10,
    'november': 11, 'nov': 11,
    'december': 12, 'dec': 12,
  };

  // First, try to find year/month pattern in consecutive segments
  for (let i = 0; i < segments.length - 1; i++) {
    const yearSegment = segments[i];
    const monthSegment = segments[i + 1];

    // Check if first segment is a valid year (4 digits, 1900-2100)
    const yearMatch = yearSegment.match(/^(\d{4})$/);
    if (!yearMatch) continue;

    const year = parseInt(yearMatch[1], 10);
    if (year < 1900 || year > 2100) continue;

    // Check if second segment is a valid month
    let month: number | null = null;

    // Try numeric month (1-12, 01-12)
    const monthMatch = monthSegment.match(/^0?([1-9]|1[0-2])$/);
    if (monthMatch) {
      month = parseInt(monthMatch[1], 10);
    } else {
      // Try month name (case-insensitive)
      const monthLower = monthSegment.toLowerCase();
      if (monthNames[monthLower]) {
        month = monthNames[monthLower];
      }
    }

    if (month !== null && month >= 1 && month <= 12) {
      return { year, month };
    }
  }

  // If no year/month pattern found, try to find just a year folder
  // Look for a 4-digit year segment that's not the filename (last segment)
  for (let i = 0; i < segments.length - 1; i++) {
    const yearSegment = segments[i];
    const yearMatch = yearSegment.match(/^(\d{4})$/);
    
    if (yearMatch) {
      const year = parseInt(yearMatch[1], 10);
      if (year >= 1900 && year <= 2100) {
        // Found a valid year folder without a month subfolder
        // Use month 1 (January) as default when only year is available
        return { year, month: 1 };
      }
    }
  }

  return null;
}

/**
 * Extracts year and month from a filename based on common date formats.
 * Recognizes patterns like:
 * - 2025-01-15_photo.jpg
 * - 20250115_photo.jpg
 * - IMG_2025-01-15_123456.jpg
 * - 2025-01_photo.jpg
 * - 15-01-2025_photo.jpg
 * - 01-15-2025_photo.jpg
 * 
 * @param filename - The filename to parse (without path)
 * @returns Object with year and month (1-12) if found, null otherwise
 */
export function extractYearMonthFromFilename(filename: string): { year: number; month: number } | null {
  if (!filename) return null;

  // Remove file extension for cleaner parsing
  const nameWithoutExt = filename.replace(/\.[^.]*$/, '');

  // Pattern 1: YYYY-MM-DD (e.g., 2025-01-15, 2025-1-15)
  let match = nameWithoutExt.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12) {
      return { year, month };
    }
  }

  // Pattern 2: YYYYMMDD (e.g., 20250115)
  match = nameWithoutExt.match(/(\d{4})(\d{2})(\d{2})/);
  if (match) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month };
    }
  }

  // Pattern 3: YYYY_MM_DD (e.g., 2025_01_15)
  match = nameWithoutExt.match(/(\d{4})_(\d{1,2})_(\d{1,2})/);
  if (match) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12) {
      return { year, month };
    }
  }

  // Pattern 4: YYYY-MM (e.g., 2025-01)
  match = nameWithoutExt.match(/(\d{4})-(\d{1,2})(?![-\d])/);
  if (match) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12) {
      return { year, month };
    }
  }

  // Pattern 5: YYYYMM (e.g., 202501) - must be followed by non-digit or end of string
  match = nameWithoutExt.match(/(\d{4})(\d{2})(?![0-9])/);
  if (match) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12) {
      return { year, month };
    }
  }

  // Pattern 6: DD-MM-YYYY (e.g., 15-01-2025)
  match = nameWithoutExt.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (match) {
    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);
    // Validate: if day is > 12, it's likely DD-MM-YYYY format
    if (day > 12 && year >= 1900 && year <= 2100 && month >= 1 && month <= 12) {
      return { year, month };
    }
    // If day <= 12, could be ambiguous, but prefer DD-MM-YYYY if year is at the end
    if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month };
    }
  }

  // Pattern 7: MM-DD-YYYY (e.g., 01-15-2025)
  match = nameWithoutExt.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (match) {
    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);
    // Validate: if first number > 12, it can't be MM-DD-YYYY, skip
    // If second number > 12, it's likely MM-DD-YYYY
    if (month <= 12 && day > 12 && year >= 1900 && year <= 2100 && month >= 1 && day >= 1 && day <= 31) {
      return { year, month };
    }
  }

  return null;
}

