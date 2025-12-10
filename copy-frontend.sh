#!/bin/bash
# Script to build the frontend and copy it to the backend's frontend directory

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$SCRIPT_DIR/../nazr-frontend-web"
BACKEND_DIR="$SCRIPT_DIR"

echo "Building frontend..."
cd "$FRONTEND_DIR"

if [ ! -f "package.json" ]; then
    echo "Error: Frontend directory not found at $FRONTEND_DIR"
    echo "Please ensure the frontend project is at the correct location."
    exit 1
fi

npm run build
if [ $? -ne 0 ]; then
    echo "Error: Frontend build failed"
    exit 1
fi

echo ""
echo "Copying frontend files to backend..."
cd "$BACKEND_DIR"

# Create frontend directory if it doesn't exist
mkdir -p frontend/assets

# Copy all files from dist to frontend
cp -r "$FRONTEND_DIR/dist/"* frontend/

echo ""
echo "Frontend files copied successfully!"
echo "You can now run the backend and it will serve the frontend."
echo ""

