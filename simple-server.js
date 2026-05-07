const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Database setup
const dbPath = process.env.NODE_ENV === 'production' ? '/tmp/attendance.db' : './attendance.db';
const db = new sqlite3.Database(dbPath, (err) => {
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
    section TEXT,
    qr_code TEXT,
    status TEXT DEFAULT 'active',
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

  db.run(`CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Insert default sections if they don't exist
  const defaultSections = [
    { code: 'A', name: 'Section A' },
    { code: 'B', name: 'Section B' },
    { code: 'C', name: 'Section C' },
    { code: 'D', name: 'Section D' }
  ];

  defaultSections.forEach(section => {
    db.run(
      'INSERT OR IGNORE INTO sections (code, name) VALUES (?, ?)',
      [section.code, section.name],
      (err) => {
        if (err) {
          console.error(`Error inserting section ${section.code}:`, err);
        }
      }
    );
  });

  // Add status column if it doesn't exist and update existing records
  db.run(`ALTER TABLE students ADD COLUMN status TEXT DEFAULT 'active'`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding status column:', err);
    } else {
      console.log('Status column added or already exists');
      
      // Update any existing students with null status
      db.run(`UPDATE students SET status = 'active' WHERE status IS NULL OR status = ''`, (updateErr) => {
        if (updateErr) {
          console.error('Error updating student status:', updateErr);
        } else {
          console.log('Updated student status values');
        }
      });
    }
  });
});

// API Routes

// Add student
app.post('/api/students', (req, res) => {
  const { studentId, name, section } = req.body;
  
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
      'INSERT INTO students (student_id, name, section, qr_code) VALUES (?, ?, ?, ?)',
      [studentId, name, section, qrCode],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Student ID already exists. Please use a different Student ID.' });
          }
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
  db.all('SELECT * FROM students WHERE status = ? OR status IS NULL ORDER BY name', ['active'], (err, rows) => {
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


// Delete student (actually delete from database)
app.delete('/api/students/:studentId', (req, res) => {
  const { studentId } = req.params;
  
  // First delete student's attendance records
  db.run('DELETE FROM attendance WHERE student_id = ?', [studentId], (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to delete student attendance records' });
    }
    
    // Then delete the student
    db.run('DELETE FROM students WHERE student_id = ?', [studentId], function(err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to delete student' });
      } else if (this.changes === 0) {
        return res.status(404).json({ error: 'Student not found' });
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

      // Check if student exists and is active
      db.get(
        'SELECT * FROM students WHERE student_id = ?',
        [studentId],
        (err, student) => {
          if (err || !student) {
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
          db.get(
            'SELECT * FROM attendance WHERE student_id = ? AND section = ?',
            [studentId, session.section],
            (err, existing) => {
              if (err) {
                return res.status(500).json({ error: 'Database error' });
              }

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
  const section = req.query.section;
  let query = 'SELECT * FROM attendance ORDER BY section, scan_time';
  let params = [];
  
  if (section) {
    query = 'SELECT * FROM attendance WHERE section = ? ORDER BY scan_time';
    params = [section];
  }
  
  db.all(query, params, (err, rows) => {
    if (err) {
      res.status(500).json({ error: 'Failed to fetch attendance' });
    } else {
      // Generate CSV
      let csv = 'Section,Student ID,Name,Scan Time\n';
      rows.forEach(row => {
        csv += `"${row.section}","${row.student_id}","${row.name}","${row.scan_time}"\n`;
      });

      const filename = section ? `attendance_${section}.csv` : 'attendance.csv';
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
      res.send(csv);
    }
  });
});



// Get student scan count for specific section/period
app.get('/api/students/:studentId/scan-count', (req, res) => {
  const { studentId } = req.params;
  const { section, startDate, endDate } = req.query;
  
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
  
  db.get(query, params, (err, row) => {
    if (err) {
      res.status(500).json({ error: 'Failed to get scan count' });
    } else {
      res.json({ 
        studentId, 
        scanCount: row.scanCount || 0,
        section,
        startDate,
        endDate
      });
    }
  });
});

// Get all attendance records for a specific student
app.get('/api/students/:studentId/attendance', (req, res) => {
  const { studentId } = req.params;
  const { section, startDate, endDate } = req.query;
  
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
  
  db.all(query, params, (err, rows) => {
    if (err) {
      res.status(500).json({ error: 'Failed to get attendance records' });
    } else {
      res.json({ 
        studentId, 
        attendance: rows,
        section,
        startDate,
        endDate
      });
    }
  });
});

// Get all students with their scan counts for a section
app.get('/api/students/scan-counts', (req, res) => {
  const { section, startDate, endDate } = req.query;
  
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
  
  db.all(query, params, (err, rows) => {
    if (err) {
      res.status(500).json({ error: 'Failed to get student scan counts' });
    } else {
      res.json(rows);
    }
  });
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

// Section Management API Endpoints

// Get all sections
app.get('/api/sections', (req, res) => {
  db.all('SELECT * FROM sections ORDER BY code', (err, rows) => {
    if (err) {
      res.status(500).json({ error: 'Failed to fetch sections' });
    } else {
      res.json(rows);
    }
  });
});

// Add new section
app.post('/api/sections', (req, res) => {
  const { code, name } = req.body;
  
  if (!code || !name) {
    return res.status(400).json({ error: 'Section code and name are required' });
  }

  db.run(
    'INSERT INTO sections (code, name) VALUES (?, ?)',
    [code.toUpperCase(), name],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          res.status(400).json({ error: 'Section code already exists' });
        } else {
          res.status(500).json({ error: 'Failed to add section' });
        }
      } else {
        res.json({ 
          success: true, 
          message: 'Section added successfully',
          id: this.lastID
        });
      }
    }
  );
});

// Update section
app.put('/api/sections/:id', (req, res) => {
  const { id } = req.params;
  const { code, name, status } = req.body;
  
  if (!code || !name) {
    return res.status(400).json({ error: 'Section code and name are required' });
  }

  db.run(
    'UPDATE sections SET code = ?, name = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [code.toUpperCase(), name, status || 'active', id],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          res.status(400).json({ error: 'Section code already exists' });
        } else {
          res.status(500).json({ error: 'Failed to update section' });
        }
      } else if (this.changes === 0) {
        res.status(404).json({ error: 'Section not found' });
      } else {
        res.json({ success: true, message: 'Section updated successfully' });
      }
    }
  );
});

// Delete section
app.delete('/api/sections/:id', (req, res) => {
  const { id } = req.params;
  
  // Check if section has students before deleting
  db.get('SELECT code FROM sections WHERE id = ?', [id], (err, section) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to check section' });
    }
    
    if (!section) {
      return res.status(404).json({ error: 'Section not found' });
    }
    
    // Check if there are students in this section
    db.get('SELECT COUNT(*) as count FROM students WHERE section = ?', [section.code], (err, result) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to check students in section' });
      }
      
      if (result.count > 0) {
        return res.status(400).json({ 
          error: 'Cannot delete section with existing students. Please move or delete students first.' 
        });
      }
      
      // Delete the section
      db.run('DELETE FROM sections WHERE id = ?', [id], function(err) {
        if (err) {
          res.status(500).json({ error: 'Failed to delete section' });
        } else if (this.changes === 0) {
          res.status(404).json({ error: 'Section not found' });
        } else {
          res.json({ success: true, message: 'Section deleted successfully' });
        }
      });
    });
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`QR Attendance System running on http://localhost:${PORT}`);
});
