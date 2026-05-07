# Simple QR Attendance System - Setup Instructions

## Quick Setup (3 steps)

### 1. Install Dependencies
```bash
npm install
```
*Note: Only essential dependencies are installed (express, qrcode, sqlite3)*

### 2. Start Server
```bash
node simple-server.js
```

### 3. Open in Browser
Navigate to: http://localhost:3000

---

## Features

### ✅ Student Management
- Add students with ID and name
- Generate QR codes for each student
- QR codes contain: `{ "id": "studentId", "name": "studentName" }`

### ✅ Session Management
- Select section (A, B, C, D) before starting
- One active session at a time
- All scans automatically assigned to selected section

### ✅ QR Scanner
- Uses html5-qrcode library
- Webcam-based scanning
- Prevents duplicate scans per session
- Shows live scan results

### ✅ Attendance Display
- Live list of scanned students
- Shows: Student ID, Name, Section, Time
- Real-time updates

### ✅ Export
- Download attendance as CSV
- Grouped by section
- Format: Section,Student ID,Name,Scan Time

---

## How It Works

1. **Add Students**: Enter student ID and name, generate QR codes
2. **Start Session**: Select section (A, B, C, D) and click "Start Session"
3. **Scan QR Codes**: Point camera at student QR codes
4. **View Attendance**: See live list of scanned students
5. **Export Data**: Download CSV file with all attendance records

---

## Database

Uses SQLite database (`attendance.db`) with 3 tables:
- `students`: Student information
- `sessions`: Active session tracking
- `attendance`: Attendance records

---

## API Endpoints

- `POST /api/students` - Add student
- `GET /api/students` - Get all students
- `POST /api/session/start` - Start session with section
- `GET /api/session/current` - Get current session
- `POST /api/attendance` - Mark attendance
- `GET /api/attendance` - Get all attendance
- `GET /api/attendance/export` - Export CSV
- `GET /api/qrcode/:studentId/:name` - Generate QR code

---

## File Structure

```
QRPROJECT/
├── simple-server.js      # Main server file
├── simple-package.json   # Dependencies
├── public/
│   └── index.html      # Frontend interface
└── attendance.db        # SQLite database (auto-created)
```

---

## Requirements

- Node.js 14+
- Modern browser with camera support
- No internet connection required (works offline)

---

## Troubleshooting

**Server won't start**: Check if port 3000 is available
**Camera not working**: Allow camera permissions in browser
**QR codes not scanning**: Ensure good lighting and steady camera
**Database errors**: Delete `attendance.db` and restart server

---

## Demo Workflow

1. Add a few students (ID: S001, Name: John Doe)
2. Generate QR codes for them
3. Start session for Section A
4. Scan the QR codes
5. View attendance list
6. Export to CSV

That's it! Simple, fast, and reliable QR attendance system.
