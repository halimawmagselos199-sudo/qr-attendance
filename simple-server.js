const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Database setup
const db = new sqlite3.Database('./attendance.db', (err) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Connected to SQLite database');
  }
});

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT UNIQUE,
    name TEXT NOT NULL,
    qr_code TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL,
    is_active BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    name TEXT NOT NULL,
    section TEXT NOT NULL,
    scan_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(student_id)
  )`);
});

// API Routes

// Add student
app.post('/api/students', (req, res) => {
  const { studentId, name } = req.body;
  
  if (!studentId || !name) {
    return res.status(400).json({ error: 'Student ID and name are required' });
  }

  // Generate QR code
  const qrData = JSON.stringify({
    id: studentId,
    name: name,
    timestamp: new Date().toISOString()
  });

  QRCode.toDataURL(qrData, (err, qrCode) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to generate QR code' });
    }

    db.run(
      'INSERT INTO students (student_id, name, qr_code) VALUES (?, ?, ?)',
      [studentId, name, qrCode],
      function(err) {
        if (err) {
          res.status(500).json({ error: 'Failed to add student' });
        } else {
          res.json({ success: true, message: 'Student added successfully' });
        }
      }
    );
  });
});

// Get all students with QR codes
app.get('/api/students', (req, res) => {
  db.all('SELECT * FROM students ORDER BY name', (err, rows) => {
    if (err) {
      res.status(500).json({ error: 'Failed to fetch students' });
    } else {
      // Process students and generate QR codes for those that don't have one
      Promise.all(rows.map(student => {
        if (student.qr_code) {
          return Promise.resolve({
            ...student,
            qrCode: student.qr_code
          });
        } else {
          // Generate QR code for students that don't have one
          const qrData = JSON.stringify({
            id: student.student_id,
            name: student.name,
            timestamp: new Date().toISOString()
          });
          
          return QRCode.toDataURL(qrData)
            .then(qrCode => {
              // Update the database with the generated QR code
              return new Promise((resolve) => {
                db.run(
                  'UPDATE students SET qr_code = ? WHERE student_id = ?',
                  [qrCode, student.student_id],
                  () => {
                    resolve({
                      ...student,
                      qrCode: qrCode
                    });
                  }
                );
              });
            })
            .catch(error => {
              console.error('QR Code generation error:', error);
              return {
                ...student,
                qrCode: null
              };
            });
        }
      }))
      .then(studentsWithQR => {
        res.json(studentsWithQR);
      })
      .catch(error => {
        console.error('Error processing students:', error);
        res.status(500).json({ error: 'Failed to process students' });
      });
    }
  });
});


// Delete student
app.delete('/api/students/:studentId', (req, res) => {
  const { studentId } = req.params;
  
  // First delete attendance records for this student
  db.run('DELETE FROM attendance WHERE student_id = ?', [studentId], (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to delete attendance records' });
    }
    
    // Then delete the student
    db.run('DELETE FROM students WHERE student_id = ?', [studentId], (err) => {
      if (err) {
        res.status(500).json({ error: 'Failed to delete student' });
      } else {
        res.json({ success: true, message: 'Student deleted successfully' });
      }
    });
  });
});

// Start attendance session
app.post('/api/session/start', (req, res) => {
  const { section } = req.body;
  
  if (!section) {
    return res.status(400).json({ error: 'Section is required' });
  }

  // First, set all sessions to inactive
  db.run('UPDATE sessions SET is_active = 0');

  // Then create new active session
  db.run(
    'INSERT INTO sessions (section, is_active) VALUES (?, 1)',
    [section],
    function(err) {
      if (err) {
        res.status(500).json({ error: 'Failed to start session' });
      } else {
        res.json({ success: true, section, message: 'Session started successfully' });
      }
    }
  );
});

// Get current session
app.get('/api/session/current', (req, res) => {
  db.get(
    'SELECT * FROM sessions WHERE is_active = 1 LIMIT 1',
    (err, row) => {
      if (err) {
        res.status(500).json({ error: 'Failed to get current session' });
      } else {
        res.json(row || null);
      }
    }
  );
});

// End session
app.post('/api/session/end', (req, res) => {
  db.run('UPDATE sessions SET is_active = 0', (err) => {
    if (err) {
      res.status(500).json({ error: 'Failed to end session' });
    } else {
      res.json({ success: true, message: 'Session ended successfully' });
    }
  });
});

// Mark attendance
app.post('/api/attendance', (req, res) => {
  const { studentId, name } = req.body;
  
  if (!studentId || !name) {
    return res.status(400).json({ error: 'Student ID and name are required' });
  }

  // Get current session
  db.get(
    'SELECT * FROM sessions WHERE is_active = 1 LIMIT 1',
    (err, session) => {
      if (err || !session) {
        return res.status(400).json({ error: 'No active session found' });
      }

      // Check if already marked attendance
      db.get(
        'SELECT * FROM attendance WHERE student_id = ? AND section = ?',
        [studentId, session.section],
        (err, existing) => {
          if (err) {
            return res.status(500).json({ error: 'Database error' });
          }

          if (existing) {
            return res.status(400).json({ error: 'Attendance already marked for this session' });
          }

          // Mark attendance
          db.run(
            'INSERT INTO attendance (student_id, name, section) VALUES (?, ?, ?)',
            [studentId, name, session.section],
            function(err) {
              if (err) {
                res.status(500).json({ error: 'Failed to mark attendance' });
              } else {
                res.json({ 
                  success: true, 
                  studentId, 
                  name, 
                  section: session.section,
                  message: 'Attendance marked successfully' 
                });
              }
            }
          );
        }
      );
    }
  );
});

// Get attendance records
app.get('/api/attendance', (req, res) => {
  db.all(
    'SELECT * FROM attendance ORDER BY scan_time DESC',
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: 'Failed to fetch attendance' });
      } else {
        res.json(rows);
      }
    }
  );
});

// Export attendance as CSV
app.get('/api/attendance/export', (req, res) => {
  db.all(
    'SELECT * FROM attendance ORDER BY section, scan_time',
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: 'Failed to fetch attendance' });
      } else {
        // Generate CSV
        let csv = 'Section,Student ID,Name,Scan Time\n';
        rows.forEach(row => {
          csv += `"${row.section}","${row.student_id}","${row.name}","${row.scan_time}"\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=attendance.csv');
        res.send(csv);
      }
    }
  );
});

// Generate QR code for student
app.get('/api/qrcode/:studentId/:name', (req, res) => {
  const { studentId, name } = req.params;
  
  const qrData = JSON.stringify({
    id: studentId,
    name: name,
    timestamp: new Date().toISOString()
  });

  QRCode.toDataURL(qrData, (err, url) => {
    if (err) {
      res.status(500).json({ error: 'Failed to generate QR code' });
    } else {
      res.json({ qrCode: url });
    }
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`QR Attendance System running on http://localhost:${PORT}`);
});
