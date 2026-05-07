# Render.com Deployment Instructions

## Quick Deployment

1. **Push to GitHub**
   ```bash
   git add .
   git commit -m "Ready for Render deployment"
   git push origin main
   ```

2. **Deploy on Render**
   - Go to [render.com](https://render.com)
   - Sign up/login
   - Click "New" → "Web Service"
   - Connect your GitHub repository
   - Select this repository
   - Use the following settings:
     - **Name**: qr-attendance-system
     - **Environment**: Node
     - **Build Command**: `npm install`
     - **Start Command**: `node simple-server.js`
     - **Instance Type**: Free

3. **Environment Variables** (optional)
   - `NODE_ENV`: `production`
   - `PORT`: `10000` (Render's default)

## What I've Fixed

✅ **Port Configuration**: Server now uses `process.env.PORT` for Render's port 10000
✅ **Database Path**: Uses `/tmp/attendance.db` in production (Render's temporary storage)
✅ **Render Config**: Added `render.yaml` for automatic deployment setup
✅ **Git Ignore**: Updated to exclude production database files

## Important Notes

⚠️ **Database Persistence**: The free tier uses SQLite with temporary storage. Data may be lost when the instance restarts. For production, consider:
- Upgrading to a paid plan with persistent storage
- Using PostgreSQL (uncomment the database section in `render.yaml`)

⚠️ **Free Tier Limitations**: 
- Instances sleep after 15 minutes of inactivity
- Cold starts may take 30-60 seconds
- Limited to 750 hours/month

## Alternative: PostgreSQL Setup

If you want persistent data on the free tier:

1. Uncomment the PostgreSQL section in `render.yaml`
2. Update your code to use PostgreSQL instead of SQLite
3. Add `pg` dependency to `package.json`

## Verification

After deployment, your app will be available at:
`https://qr-attendance-system.onrender.com`

Test the health check by visiting the root URL.
