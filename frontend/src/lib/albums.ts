import type { Asset } from '../types';
import { assetApi } from './api';

export interface Album {
  id: string;
  name: string;
  description?: string;
  assetIds: number[];
  createdAt: number;
  updatedAt: number;
}

// Helper to convert backend album (numeric ID) to frontend album (string ID)
function backendToFrontendAlbum(backend: {
  id: number;
  name: string;
  description?: string;
  asset_ids: number[];
  created_at: number;
  updated_at: number;
}): Album {
  return {
    id: String(backend.id),
    name: backend.name,
    description: backend.description,
    assetIds: backend.asset_ids,
    createdAt: backend.created_at * 1000, // Convert seconds to milliseconds
    updatedAt: backend.updated_at * 1000,
  };
}

export async function getAlbums(): Promise<Album[]> {
  try {
    const backendAlbums = await assetApi.listAlbums();
    return backendAlbums.map(backendToFrontendAlbum);
  } catch (error) {
    console.error('Failed to fetch albums:', error);
    return [];
  }
}

export async function createAlbum(name: string, description?: string): Promise<Album> {
  try {
    const backendAlbum = await assetApi.createAlbum(name, description);
    return backendToFrontendAlbum(backendAlbum);
  } catch (error) {
    console.error('Failed to create album:', error);
    throw error;
  }
}

export async function updateAlbum(id: string, updates: Partial<Pick<Album, 'name' | 'description'>>): Promise<Album | null> {
  try {
    const albumId = parseInt(id, 10);
    if (isNaN(albumId)) {
      console.error('Invalid album ID:', id);
      return null;
    }
    const backendAlbum = await assetApi.updateAlbum(albumId, updates.name, updates.description);
    return backendToFrontendAlbum(backendAlbum);
  } catch (error) {
    console.error('Failed to update album:', error);
    // Check if it's a 404 (album not found)
    if (error instanceof Error && error.message.includes('404')) {
      return null;
    }
    throw error;
  }
}

export async function deleteAlbum(id: string): Promise<boolean> {
  try {
    const albumId = parseInt(id, 10);
    if (isNaN(albumId)) {
      console.error('Invalid album ID:', id);
      return false;
    }
    await assetApi.deleteAlbum(albumId);
    return true;
  } catch (error) {
    console.error('Failed to delete album:', error);
    // Check if it's a 404 (album not found)
    if (error instanceof Error && error.message.includes('404')) {
      return false;
    }
    throw error;
  }
}

export async function addAssetsToAlbum(albumId: string, assetIds: number[]): Promise<Album | null> {
  try {
    const id = parseInt(albumId, 10);
    if (isNaN(id)) {
      console.error('Invalid album ID:', albumId);
      return null;
    }
    const backendAlbum = await assetApi.addAssetsToAlbum(id, assetIds);
    return backendToFrontendAlbum(backendAlbum);
  } catch (error) {
    console.error('Failed to add assets to album:', error);
    // Check if it's a 404 (album not found)
    if (error instanceof Error && error.message.includes('404')) {
      return null;
    }
    throw error;
  }
}

export async function removeAssetsFromAlbum(albumId: string, assetIds: number[]): Promise<Album | null> {
  try {
    const id = parseInt(albumId, 10);
    if (isNaN(id)) {
      console.error('Invalid album ID:', albumId);
      return null;
    }
    const backendAlbum = await assetApi.removeAssetsFromAlbum(id, assetIds);
    return backendToFrontendAlbum(backendAlbum);
  } catch (error) {
    console.error('Failed to remove assets from album:', error);
    // Check if it's a 404 (album not found)
    if (error instanceof Error && error.message.includes('404')) {
      return null;
    }
    throw error;
  }
}

export async function getAlbum(id: string): Promise<Album | null> {
  try {
    const albumId = parseInt(id, 10);
    if (isNaN(albumId)) {
      console.error('Invalid album ID:', id);
      return null;
    }
    const backendAlbum = await assetApi.getAlbum(albumId);
    return backendToFrontendAlbum(backendAlbum);
  } catch (error) {
    console.error('Failed to get album:', error);
    // Check if it's a 404 (album not found)
    if (error instanceof Error && error.message.includes('404')) {
      return null;
    }
    throw error;
  }
}

export async function getAlbumsForAsset(assetId: number): Promise<Album[]> {
  try {
    const albumIds = await assetApi.getAlbumsForAsset(assetId);
    // Fetch all albums and filter
    const allAlbums = await getAlbums();
    const albumIdSet = new Set(albumIds.map(String));
    return allAlbums.filter((a) => albumIdSet.has(a.id));
  } catch (error) {
    console.error('Failed to get albums for asset:', error);
    return [];
  }
}

