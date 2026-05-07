const express = require('express');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Database setup
const dbPath = process.env.NODE_ENV === 'production' ? '/tmp/attendance.db' : './attendance.db';
const db = new Database(dbPath);
console.log('Connected to SQLite database');

// Create tables
const createStudentsTable = db.prepare(`CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT UNIQUE,
  name TEXT NOT NULL,
  section TEXT,
  qr_code TEXT,
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
createStudentsTable.run();

const createSessionsTable = db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section TEXT NOT NULL,
  is_active BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
createSessionsTable.run();

const createAttendanceTable = db.prepare(`CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  name TEXT NOT NULL,
  section TEXT NOT NULL,
  scan_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(student_id)
)`);
createAttendanceTable.run();

const createSectionsTable = db.prepare(`CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
createSectionsTable.run();

// Insert default sections if they don't exist
const defaultSections = [
  { code: 'A', name: 'Section A' },
  { code: 'B', name: 'Section B' },
  { code: 'C', name: 'Section C' },
  { code: 'D', name: 'Section D' }
];

const insertSection = db.prepare('INSERT OR IGNORE INTO sections (code, name) VALUES (?, ?)');
defaultSections.forEach(section => {
  try {
    insertSection.run(section.code, section.name);
  } catch (err) {
    console.error(`Error inserting section ${section.code}:`, err);
  }
});

// Add status column if it doesn't exist and update existing records
try {
  db.exec(`ALTER TABLE students ADD COLUMN status TEXT DEFAULT 'active'`);
  console.log('Status column added successfully');
} catch (err) {
  if (!err.message.includes('duplicate column name')) {
    console.error('Error adding status column:', err);
  } else {
    console.log('Status column already exists');
  }
}

// Update any existing students with null status
try {
  db.exec(`UPDATE students SET status = 'active' WHERE status IS NULL OR status = ''`);
  console.log('Updated student status values');
} catch (updateErr) {
  console.error('Error updating student status:', updateErr);
}

// API Routes

// Add student
app.post('/api/students', async (req, res) => {
  const { studentId, name, section } = req.body;
  
  if (!studentId || !name) {
    return res.status(400).json({ error: 'Student ID and name are required' });
  }

  try {
    // Generate QR code
    const qrData = JSON.stringify({
      id: studentId,
      name: name,
      timestamp: new Date().toISOString()
    });

    const qrCode = await QRCode.toDataURL(qrData);

    const insertStudent = db.prepare('INSERT INTO students (student_id, name, section, qr_code) VALUES (?, ?, ?, ?)');
    insertStudent.run(studentId, name, section, qrCode);
    
    res.json({ success: true, message: 'Student added successfully' });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Student ID already exists. Please use a different Student ID.' });
    }
    res.status(500).json({ error: 'Failed to add student' });
  }
});

// Get all students with QR codes
app.get('/api/students', async (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM students WHERE status = ? OR status IS NULL ORDER BY name');
    const students = stmt.all('active');

    // Process students and generate QR codes for those that don't have one
    const studentsWithQR = await Promise.all(students.map(async student => {
      if (student.qr_code) {
        return {
          ...student,
          qrCode: student.qr_code
        };
      } else {
        // Generate QR code for students that don't have one
        const qrData = JSON.stringify({
          id: student.student_id,
          name: student.name,
          timestamp: new Date().toISOString()
        });
        
        try {
          const qrCode = await QRCode.toDataURL(qrData);
          
          // Update the database with the generated QR code
          const updateQR = db.prepare('UPDATE students SET qr_code = ? WHERE student_id = ?');
          updateQR.run(qrCode, student.student_id);
          
          return {
            ...student,
            qrCode: qrCode
          };
        } catch (error) {
          console.error('QR Code generation error:', error);
          return {
            ...student,
            qrCode: null
          };
        }
      }
    }));

    res.json(studentsWithQR);
  } catch (error) {
    console.error('Error processing students:', error);
    res.status(500).json({ error: 'Failed to process students' });
  }
});

// Delete student (actually delete from database)
app.delete('/api/students/:studentId', (req, res) => {
  const { studentId } = req.params;
  
  try {
    // First delete student's attendance records
    const deleteAttendance = db.prepare('DELETE FROM attendance WHERE student_id = ?');
    deleteAttendance.run(studentId);
    
    // Then delete the student
    const deleteStudent = db.prepare('DELETE FROM students WHERE student_id = ?');
    const result = deleteStudent.run(studentId);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    
    res.json({ success: true, message: 'Student deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete student' });
  }
});

// Start attendance session
app.post('/api/session/start', (req, res) => {
  const { section } = req.body;
  
  if (!section) {
    return res.status(400).json({ error: 'Section is required' });
  }

  try {
    // First, set all sessions to inactive
    const deactivateAll = db.prepare('UPDATE sessions SET is_active = 0');
    deactivateAll.run();

    // Then create new active session
    const createSession = db.prepare('INSERT INTO sessions (section, is_active) VALUES (?, 1)');
    createSession.run(section);
    
    res.json({ success: true, section, message: 'Session started successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// Get current session
app.get('/api/session/current', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM sessions WHERE is_active = 1 LIMIT 1');
    const session = stmt.get();
    res.json(session || null);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get current session' });
  }
});

// End session
app.post('/api/session/end', (req, res) => {
  try {
    const endSession = db.prepare('UPDATE sessions SET is_active = 0');
    endSession.run();
    res.json({ success: true, message: 'Session ended successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to end session' });
  }
});

// Mark attendance
app.post('/api/attendance', (req, res) => {
  const { studentId, name } = req.body;
  
  if (!studentId || !name) {
    return res.status(400).json({ error: 'Student ID and name are required' });
  }

  try {
    // Get current session
    const getSession = db.prepare('SELECT * FROM sessions WHERE is_active = 1 LIMIT 1');
    const session = getSession.get();
    
    if (!session) {
      return res.status(400).json({ error: 'No active session found' });
    }

    // Check if student exists and is active
    const getStudent = db.prepare('SELECT * FROM students WHERE student_id = ?');
    const student = getStudent.get(studentId);
    
    if (!student) {
      return res.status(400).json({ error: 'Student not found' });
    }

    // Check student status (treat null/undefined as active for backward compatibility)
    if (student.status && student.status !== 'active') {
      return res.status(400).json({ 
        error: 'Student is no longer active',
        message: `${name} - Student record is inactive`
      });
    }

    // Check if student's section matches the active session section
    if (student.section !== session.section) {
      return res.status(400).json({ 
        error: 'Section mismatch',
        message: `${name} - Cannot scan. Student is from Section ${student.section} but active session is for Section ${session.section}`,
        studentSection: student.section,
        sessionSection: session.section
      });
    }

    // Check if already marked attendance
    const checkAttendance = db.prepare('SELECT * FROM attendance WHERE student_id = ? AND section = ?');
    const existing = checkAttendance.get(studentId, session.section);

    if (existing) {
      return res.json({ 
        success: true, 
        studentId, 
        name, 
        section: session.section,
        alreadyScanned: true,
        message: `${name} - Attendance already recorded` 
      });
    }

    // Mark attendance
    const markAttendance = db.prepare('INSERT INTO attendance (student_id, name, section) VALUES (?, ?, ?)');
    markAttendance.run(studentId, name, session.section);
    
    res.json({ 
      success: true, 
      studentId, 
      name, 
      section: session.section,
      message: 'Attendance marked successfully' 
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark attendance' });
  }
});

// Get attendance records
app.get('/api/attendance', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM attendance ORDER BY scan_time DESC');
    const records = stmt.all();
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

// Export attendance as CSV
app.get('/api/attendance/export', (req, res) => {
  const section = req.query.section;
  
  try {
    let query = 'SELECT * FROM attendance ORDER BY section, scan_time';
    let stmt;
    
    if (section) {
      stmt = db.prepare('SELECT * FROM attendance WHERE section = ? ORDER BY scan_time');
      var records = stmt.all(section);
    } else {
      stmt = db.prepare(query);
      var records = stmt.all();
    }
    
    // Generate CSV
    let csv = 'Section,Student ID,Name,Scan Time\n';
    records.forEach(row => {
      csv += `"${row.section}","${row.student_id}","${row.name}","${row.scan_time}"\n`;
    });

    const filename = section ? `attendance_${section}.csv` : 'attendance.csv';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

// Get student scan count for specific section/period
app.get('/api/students/:studentId/scan-count', (req, res) => {
  const { studentId } = req.params;
  const { section, startDate, endDate } = req.query;
  
  try {
    let query = 'SELECT COUNT(*) as scanCount FROM attendance WHERE student_id = ?';
    let params = [studentId];
    
    if (section) {
      query += ' AND section = ?';
      params.push(section);
    }
    
    if (startDate) {
      query += ' AND scan_time >= ?';
      params.push(startDate);
    }
    
    if (endDate) {
      query += ' AND scan_time <= ?';
      params.push(endDate);
    }
    
    const stmt = db.prepare(query);
    const result = stmt.get(...params);
    
    res.json({ 
      studentId, 
      scanCount: result.scanCount || 0,
      section,
      startDate,
      endDate
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get scan count' });
  }
});

// Get all attendance records for a specific student
app.get('/api/students/:studentId/attendance', (req, res) => {
  const { studentId } = req.params;
  const { section, startDate, endDate } = req.query;
  
  try {
    let query = 'SELECT * FROM attendance WHERE student_id = ?';
    let params = [studentId];
    
    if (section) {
      query += ' AND section = ?';
      params.push(section);
    }
    
    if (startDate) {
      query += ' AND scan_time >= ?';
      params.push(startDate);
    }
    
    if (endDate) {
      query += ' AND scan_time <= ?';
      params.push(endDate);
    }
    
    query += ' ORDER BY scan_time DESC';
    
    const stmt = db.prepare(query);
    const records = stmt.all(...params);
    
    res.json({ 
      studentId, 
      attendance: records,
      section,
      startDate,
      endDate
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get attendance records' });
  }
});

// Get all students with their scan counts for a section
app.get('/api/students/scan-counts', (req, res) => {
  const { section, startDate, endDate } = req.query;
  
  try {
    let query = `
      SELECT s.student_id, s.name, s.section, COUNT(a.id) as scanCount 
      FROM students s 
      LEFT JOIN attendance a ON s.student_id = a.student_id
    `;
    let params = [];
    
    let whereConditions = [];
    if (section) {
      whereConditions.push('s.section = ?');
      params.push(section);
    }
    
    if (startDate) {
      whereConditions.push('(a.scan_time >= ? OR a.scan_time IS NULL)');
      params.push(startDate);
    }
    
    if (endDate) {
      whereConditions.push('(a.scan_time <= ? OR a.scan_time IS NULL)');
      params.push(endDate);
    }
    
    if (whereConditions.length > 0) {
      query += ' WHERE ' + whereConditions.join(' AND ');
    }
    
    query += ' GROUP BY s.student_id, s.name, s.section ORDER BY s.name';
    
    const stmt = db.prepare(query);
    const results = stmt.all(...params);
    
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get student scan counts' });
  }
});

// Generate QR code for student
app.get('/api/qrcode/:studentId/:name', async (req, res) => {
  const { studentId, name } = req.params;
  
  try {
    const qrData = JSON.stringify({
      id: studentId,
      name: name,
      timestamp: new Date().toISOString()
    });

    const qrCode = await QRCode.toDataURL(qrData);
    res.json({ qrCode: qrCode });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Section Management API Endpoints

// Get all sections
app.get('/api/sections', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM sections ORDER BY code');
    const sections = stmt.all();
    res.json(sections);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sections' });
  }
});

// Add new section
app.post('/api/sections', (req, res) => {
  const { code, name } = req.body;
  
  if (!code || !name) {
    return res.status(400).json({ error: 'Section code and name are required' });
  }

  try {
    const insertSection = db.prepare('INSERT INTO sections (code, name) VALUES (?, ?)');
    insertSection.run(code.toUpperCase(), name);
    
    res.json({ 
      success: true, 
      message: 'Section added successfully'
    });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      res.status(400).json({ error: 'Section code already exists' });
    } else {
      res.status(500).json({ error: 'Failed to add section' });
    }
  }
});

// Update section
app.put('/api/sections/:id', (req, res) => {
  const { id } = req.params;
  const { code, name, status } = req.body;
  
  if (!code || !name) {
    return res.status(400).json({ error: 'Section code and name are required' });
  }

  try {
    const updateSection = db.prepare('UPDATE sections SET code = ?, name = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const result = updateSection.run(code.toUpperCase(), name, status || 'active', id);
    
    if (result.changes === 0) {
      res.status(404).json({ error: 'Section not found' });
    } else {
      res.json({ success: true, message: 'Section updated successfully' });
    }
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      res.status(400).json({ error: 'Section code already exists' });
    } else {
      res.status(500).json({ error: 'Failed to update section' });
    }
  }
});

// Delete section
app.delete('/api/sections/:id', (req, res) => {
  const { id } = req.params;
  
  try {
    // Check if section exists
    const getSection = db.prepare('SELECT code FROM sections WHERE id = ?');
    const section = getSection.get(id);
    
    if (!section) {
      return res.status(404).json({ error: 'Section not found' });
    }
    
    // Check if there are students in this section
    const checkStudents = db.prepare('SELECT COUNT(*) as count FROM students WHERE section = ?');
    const result = checkStudents.get(section.code);
    
    if (result.count > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete section with existing students. Please move or delete students first.' 
      });
    }
    
    // Delete the section
    const deleteSection = db.prepare('DELETE FROM sections WHERE id = ?');
    const deleteResult = deleteSection.run(id);
    
    if (deleteResult.changes === 0) {
      res.status(404).json({ error: 'Section not found' });
    } else {
      res.json({ success: true, message: 'Section deleted successfully' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete section' });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`QR Attendance System running on http://localhost:${PORT}`);
});
