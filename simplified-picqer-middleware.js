/**
 * Simplified Picqer Middleware
 * 
 * A streamlined solution that focuses only on the core functionality:
 * 1. Connecting to Picqer API
 * 2. Fetching data from Picqer
 * 3. Storing data in SQL database
 * 4. Providing simple API endpoints for triggering sync
 * 
 * This version uses full sync only (no incremental sync) to reduce complexity.
 */

// Load environment variables
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sql = require('mssql');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

// Create Express app
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database configuration
const dbConfig = {
  server: process.env.DB_HOST || process.env.SQL_SERVER,
  port: parseInt(process.env.DB_PORT || process.env.SQL_PORT || '1433'),
  database: process.env.DB_NAME || process.env.SQL_DATABASE,
  user: process.env.DB_USER || process.env.SQL_USER,
  password: process.env.DB_PASSWORD || process.env.SQL_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: false
  }
};

// Picqer API configuration
const picqerConfig = {
  apiKey: process.env.PICQER_API_KEY,
  baseUrl: process.env.PICQER_BASE_URL || process.env.PICQER_API_URL,
  requestsPerMinute: 30
};

// Global variables
let dbPool = null;
let syncInProgress = false;
let lastSyncResults = {};

// Initialize database connection pool
async function initializeDatabase() {
  try {
    console.log('Initializing database connection pool...');
    dbPool = await sql.connect(dbConfig);
    console.log('Database connection pool initialized successfully');
    
    // Create tables if they don't exist
    await createTablesIfNotExist();
    
    return true;
  } catch (error) {
    console.error('Error initializing database:', error.message);
    return false;
  }
}

// Create necessary tables if they don't exist
async function createTablesIfNotExist() {
  try {
    // Create products table
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'products')
      CREATE TABLE products (
        id INT PRIMARY KEY,
        idproduct VARCHAR(255),
        name NVARCHAR(255),
        sku VARCHAR(255),
        barcode VARCHAR(255),
        price DECIMAL(10, 2),
        stock INT,
        sync_date DATETIME DEFAULT GETDATE()
      )
    `);
    
    // Create picklists table
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'picklists')
      CREATE TABLE picklists (
        id INT PRIMARY KEY,
        idpicklist VARCHAR(255),
        status VARCHAR(50),
        created DATETIME,
        completed DATETIME,
        warehouse_id INT,
        sync_date DATETIME DEFAULT GETDATE()
      )
    `);
    
    // Create warehouses table
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'warehouses')
      CREATE TABLE warehouses (
        id INT PRIMARY KEY,
        idwarehouse VARCHAR(255),
        name NVARCHAR(255),
        sync_date DATETIME DEFAULT GETDATE()
      )
    `);
    
    // Create sync_status table
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'sync_status')
      CREATE TABLE sync_status (
        entity VARCHAR(50) PRIMARY KEY,
        last_sync DATETIME,
        record_count INT,
        status VARCHAR(50)
      )
    `);
    
    console.log('Database tables created/verified successfully');
  } catch (error) {
    console.error('Error creating tables:', error.message);
    throw error;
  }
}

// Simple Picqer API client
class PicqerClient {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.requestsPerMinute = config.requestsPerMinute || 30;
    this.requestQueue = [];
    this.processing = false;
    
    // Start request processor
    this.startRequestProcessor();
  }
  
  // Add request to queue
  async request(method, endpoint, data = null) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({
        method,
        endpoint,
        data,
        resolve,
        reject
      });
      
      if (!this.processing) {
        this.processNextRequest();
      }
    });
  }
  
  // Process next request in queue
  async processNextRequest() {
    if (this.requestQueue.length === 0) {
      this.processing = false;
      return;
    }
    
    this.processing = true;
    const request = this.requestQueue.shift();
    
    try {
      const response = await axios({
        method: request.method,
        url: `${this.baseUrl}/${request.endpoint}`,
        data: request.data,
        headers: {
          'Authorization': `Basic ${Buffer.from(this.apiKey + ':').toString('base64')}`,
          'Content-Type': 'application/json'
        }
      });
      
      request.resolve(response.data);
    } catch (error) {
      console.error(`Error in Picqer API request to ${request.endpoint}:`, error.message);
      request.reject(error);
    }
    
    // Wait before processing next request to respect rate limits
    setTimeout(() => {
      this.processNextRequest();
    }, (60 * 1000) / this.requestsPerMinute);
  }
  
  // Start request processor
  startRequestProcessor() {
    if (!this.processing && this.requestQueue.length > 0) {
      this.processNextRequest();
    }
  }
  
  // Get all products
  async getProducts() {
    return this.request('get', 'products');
  }
  
  // Get all picklists
  async getPicklists() {
    return this.request('get', 'picklists');
  }
  
  // Get all warehouses
  async getWarehouses() {
    return this.request('get', 'warehouses');
  }
}

// Create Picqer client
const picqerClient = new PicqerClient(picqerConfig);

// Sync products
async function syncProducts() {
  try {
    console.log('Syncing products...');
    
    // Get products from Picqer
    const products = await picqerClient.getProducts();
    console.log(`Retrieved ${products.length} products from Picqer`);
    
    // Clear existing products
    await dbPool.request().query('DELETE FROM products');
    
    // Insert products into database
    let insertedCount = 0;
    for (const product of products) {
      try {
        await dbPool.request()
          .input('id', sql.Int, product.idproduct)
          .input('idproduct', sql.VarChar(255), product.idproduct)
          .input('name', sql.NVarChar(255), product.name)
          .input('sku', sql.VarChar(255), product.sku || '')
          .input('barcode', sql.VarChar(255), product.barcode || '')
          .input('price', sql.Decimal(10, 2), product.price || 0)
          .input('stock', sql.Int, product.stock || 0)
          .query(`
            INSERT INTO products (id, idproduct, name, sku, barcode, price, stock, sync_date)
            VALUES (@id, @idproduct, @name, @sku, @barcode, @price, @stock, GETDATE())
          `);
        
        insertedCount++;
      } catch (error) {
        console.error(`Error inserting product ${product.idproduct}:`, error.message);
      }
    }
    
    // Update sync status
    await dbPool.request()
      .input('entity', sql.VarChar(50), 'products')
      .input('count', sql.Int, insertedCount)
      .query(`
        IF EXISTS (SELECT * FROM sync_status WHERE entity = @entity)
          UPDATE sync_status SET last_sync = GETDATE(), record_count = @count, status = 'success'
          WHERE entity = @entity
        ELSE
          INSERT INTO sync_status (entity, last_sync, record_count, status)
          VALUES (@entity, GETDATE(), @count, 'success')
      `);
    
    console.log(`Synced ${insertedCount} products successfully`);
    return {
      success: true,
      count: insertedCount
    };
  } catch (error) {
    console.error('Error syncing products:', error.message);
    
    // Update sync status
    try {
      await dbPool.request()
        .input('entity', sql.VarChar(50), 'products')
        .input('error', sql.VarChar(255), error.message.substring(0, 255))
        .query(`
          IF EXISTS (SELECT * FROM sync_status WHERE entity = @entity)
            UPDATE sync_status SET last_sync = GETDATE(), status = 'error: ' + @error
            WHERE entity = @entity
          ELSE
            INSERT INTO sync_status (entity, last_sync, record_count, status)
            VALUES (@entity, GETDATE(), 0, 'error: ' + @error)
        `);
    } catch (statusError) {
      console.error('Error updating sync status:', statusError.message);
    }
    
    return {
      success: false,
      error: error.message
    };
  }
}

// Sync picklists
async function syncPicklists() {
  try {
    console.log('Syncing picklists...');
    
    // Get picklists from Picqer
    const picklists = await picqerClient.getPicklists();
    console.log(`Retrieved ${picklists.length} picklists from Picqer`);
    
    // Clear existing picklists
    await dbPool.request().query('DELETE FROM picklists');
    
    // Insert picklists into database
    let insertedCount = 0;
    for (const picklist of picklists) {
      try {
        await dbPool.request()
          .input('id', sql.Int, picklist.idpicklist)
          .input('idpicklist', sql.VarChar(255), picklist.idpicklist)
          .input('status', sql.VarChar(50), picklist.status || '')
          .input('created', sql.DateTime, new Date(picklist.created))
          .input('completed', sql.DateTime, picklist.completed ? new Date(picklist.completed) : null)
          .input('warehouse_id', sql.Int, picklist.warehouse_id || 0)
          .query(`
            INSERT INTO picklists (id, idpicklist, status, created, completed, warehouse_id, sync_date)
            VALUES (@id, @idpicklist, @status, @created, @completed, @warehouse_id, GETDATE())
          `);
        
        insertedCount++;
      } catch (error) {
        console.error(`Error inserting picklist ${picklist.idpicklist}:`, error.message);
      }
    }
    
    // Update sync status
    await dbPool.request()
      .input('entity', sql.VarChar(50), 'picklists')
      .input('count', sql.Int, insertedCount)
      .query(`
        IF EXISTS (SELECT * FROM sync_status WHERE entity = @entity)
          UPDATE sync_status SET last_sync = GETDATE(), record_count = @count, status = 'success'
          WHERE entity = @entity
        ELSE
          INSERT INTO sync_status (entity, last_sync, record_count, status)
          VALUES (@entity, GETDATE(), @count, 'success')
      `);
    
    console.log(`Synced ${insertedCount} picklists successfully`);
    return {
      success: true,
      count: insertedCount
    };
  } catch (error) {
    console.error('Error syncing picklists:', error.message);
    
    // Update sync status
    try {
      await dbPool.request()
        .input('entity', sql.VarChar(50), 'picklists')
        .input('error', sql.VarChar(255), error.message.substring(0, 255))
        .query(`
          IF EXISTS (SELECT * FROM sync_status WHERE entity = @entity)
            UPDATE sync_status SET last_sync = GETDATE(), status = 'error: ' + @error
            WHERE entity = @entity
          ELSE
            INSERT INTO sync_status (entity, last_sync, record_count, status)
            VALUES (@entity, GETDATE(), 0, 'error: ' + @error)
        `);
    } catch (statusError) {
      console.error('Error updating sync status:', statusError.message);
    }
    
    return {
      success: false,
      error: error.message
    };
  }
}

// Sync warehouses
async function syncWarehouses() {
  try {
    console.log('Syncing warehouses...');
    
    // Get warehouses from Picqer
    const warehouses = await picqerClient.getWarehouses();
    console.log(`Retrieved ${warehouses.length} warehouses from Picqer`);
    
    // Clear existing warehouses
    await dbPool.request().query('DELETE FROM warehouses');
    
    // Insert warehouses into database
    let insertedCount = 0;
    for (const warehouse of warehouses) {
      try {
        await dbPool.request()
          .input('id', sql.Int, warehouse.idwarehouse)
          .input('idwarehouse', sql.VarChar(255), warehouse.idwarehouse)
          .input('name', sql.NVarChar(255), warehouse.name)
          .query(`
            INSERT INTO warehouses (id, idwarehouse, name, sync_date)
            VALUES (@id, @idwarehouse, @name, GETDATE())
          `);
        
        insertedCount++;
      } catch (error) {
        console.error(`Error inserting warehouse ${warehouse.idwarehouse}:`, error.message);
      }
    }
    
    // Update sync status
    await dbPool.request()
      .input('entity', sql.VarChar(50), 'warehouses')
      .input('count', sql.Int, insertedCount)
      .query(`
        IF EXISTS (SELECT * FROM sync_status WHERE entity = @entity)
          UPDATE sync_status SET last_sync = GETDATE(), record_count = @count, status = 'success'
          WHERE entity = @entity
        ELSE
          INSERT INTO sync_status (entity, last_sync, record_count, status)
          VALUES (@entity, GETDATE(), @count, 'success')
      `);
    
    console.log(`Synced ${insertedCount} warehouses successfully`);
    return {
      success: true,
      count: insertedCount
    };
  } catch (error) {
    console.error('Error syncing warehouses:', error.message);
    
    // Update sync status
    try {
      await dbPool.request()
        .input('entity', sql.VarChar(50), 'warehouses')
        .input('error', sql.VarChar(255), error.message.substring(0, 255))
        .query(`
          IF EXISTS (SELECT * FROM sync_status WHERE entity = @entity)
            UPDATE sync_status SET last_sync = GETDATE(), status = 'error: ' + @error
            WHERE entity = @entity
          ELSE
            INSERT INTO sync_status (entity, last_sync, record_count, status)
            VALUES (@entity, GETDATE(), 0, 'error: ' + @error)
        `);
    } catch (statusError) {
      console.error('Error updating sync status:', statusError.message);
    }
    
    return {
      success: false,
      error: error.message
    };
  }
}

// Sync all entities
async function syncAll() {
  if (syncInProgress) {
    console.log('Sync already in progress, skipping request');
    return {
      success: false,
      error: 'Sync already in progress'
    };
  }
  
  syncInProgress = true;
  console.log('Starting sync for all entities...');
  
  try {
    // Sync all entities in sequence
    const productsResult = await syncProducts();
    const picklistsResult = await syncPicklists();
    const warehousesResult = await syncWarehouses();
    
    // Store results
    lastSyncResults = {
      timestamp: new Date().toISOString(),
      products: productsResult,
      picklists: picklistsResult,
      warehouses: warehousesResult,
      success: productsResult.success || picklistsResult.success || warehousesResult.success
    };
    
    console.log('Sync completed for all entities');
    syncInProgress = false;
    
    return lastSyncResults;
  } catch (error) {
    console.error('Error in syncAll:', error.message);
    
    lastSyncResults = {
      timestamp: new Date().toISOString(),
      error: error.message,
      success: false
    };
    
    syncInProgress = false;
    return lastSyncResults;
  }
}

// API Routes

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    online: true,
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    database: dbPool ? 'connected' : 'disconnected',
    picqer: picqerConfig.baseUrl ? 'configured' : 'not configured'
  });
});

// Sync endpoint
app.post('/api/sync', async (req, res) => {
  try {
    // Start sync in background
    syncAll().catch(error => {
      console.error('Error in background sync:', error.message);
    });
    
    // Return success immediately
    res.json({
      success: true,
      message: 'Sync started for all entities',
      background: true
    });
  } catch (error) {
    console.error('Error in sync endpoint:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Entity-specific sync endpoints
app.post('/api/sync/:entity', async (req, res) => {
  try {
    const entity = req.params.entity;
    console.log(`${entity} sync request received`);
    
    let syncPromise;
    
    switch (entity) {
      case 'products':
        syncPromise = syncProducts();
        break;
      case 'picklists':
        syncPromise = syncPicklists();
        break;
      case 'warehouses':
        syncPromise = syncWarehouses();
        break;
      default:
        return res.status(400).json({
          success: false,
          message: `Unknown entity type: ${entity}`
        });
    }
    
    // Start sync in background
    syncPromise.catch(error => {
      console.error(`Error in ${entity} sync:`, error.message);
    });
    
    // Return success immediately
    res.json({
      success: true,
      message: `Sync started for ${entity}`,
      background: true
    });
  } catch (error) {
    console.error(`Error in ${req.params.entity} sync endpoint:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Sync results endpoint
app.get('/api/sync/results', (req, res) => {
  res.json({
    inProgress: syncInProgress,
    lastResults: lastSyncResults
  });
});

// Stats endpoint
app.get('/api/stats', async (req, res) => {
  try {
    // Get stats from database
    const result = await dbPool.request().query(`
      SELECT entity, last_sync, record_count, status
      FROM sync_status
    `);
    
    const stats = {};
    
    // Process results
    for (const row of result.recordset) {
      stats[row.entity] = {
        lastSyncDate: row.last_sync,
        totalCount: row.record_count,
        status: row.status
      };
    }
    
    // Add default values for missing entities
    const entities = ['products', 'picklists', 'warehouses'];
    for (const entity of entities) {
      if (!stats[entity]) {
        stats[entity] = {
          lastSyncDate: null,
          totalCount: 0,
          status: 'Not synced yet'
        };
      }
    }
    
    res.json({
      success: true,
      stats,
      syncInProgress
    });
  } catch (error) {
    console.error('Error in stats endpoint:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create dashboard directory if it doesn't exist
const dashboardDir = path.join(__dirname, 'dashboard');
if (!fs.existsSync(dashboardDir)) {
  console.log('Creating dashboard directory');
  fs.mkdirSync(dashboardDir, { recursive: true });
}

// Create a simple dashboard HTML file
const dashboardHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Picqer Middleware Dashboard</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      padding: 20px;
      line-height: 1.6;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 {
      color: #333;
    }
    .card {
      background: #f9f9f9;
      border: 1px solid #ddd;
      border-radius: 4px;
      padding: 15px;
      margin-bottom: 20px;
    }
    .button {
      background: #4CAF50;
      color: white;
      border: none;
      padding: 10px 15px;
      text-align: center;
      text-decoration: none;
      display: inline-block;
      font-size: 16px;
      margin: 4px 2px;
      cursor: pointer;
      border-radius: 4px;
    }
    .button:disabled {
      background: #cccccc;
      cursor: not-allowed;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    table, th, td {
      border: 1px solid #ddd;
    }
    th, td {
      padding: 10px;
      text-align: left;
    }
    th {
      background-color: #f2f2f2;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Picqer Middleware Dashboard</h1>
    
    <div class="card">
      <h2>Status</h2>
      <div id="status">Loading...</div>
    </div>
    
    <div class="card">
      <h2>Sync Data</h2>
      <button id="sync-all-btn" class="button">Sync All Entities</button>
      <button id="sync-products-btn" class="button">Sync Products</button>
      <button id="sync-picklists-btn" class="button">Sync Picklists</button>
      <button id="sync-warehouses-btn" class="button">Sync Warehouses</button>
    </div>
    
    <div class="card">
      <h2>Sync Statistics</h2>
      <div id="stats">Loading...</div>
    </div>
    
    <div class="card">
      <h2>Last Sync Results</h2>
      <div id="results">No sync results yet</div>
    </div>
  </div>

  <script>
    // Function to fetch status
    async function fetchStatus() {
      try {
        const response = await fetch('/api/status');
        const data = await response.json();
        
        let statusHtml = '<table>';
        statusHtml += '<tr><th>Component</th><th>Status</th></tr>';
        statusHtml += \`<tr><td>API</td><td>\${data.online ? 'Online' : 'Offline'}</td></tr>\`;
        statusHtml += \`<tr><td>Database</td><td>\${data.database}</td></tr>\`;
        statusHtml += \`<tr><td>Picqer API</td><td>\${data.picqer}</td></tr>\`;
        statusHtml += \`<tr><td>Version</td><td>\${data.version}</td></tr>\`;
        statusHtml += \`<tr><td>Last Check</td><td>\${new Date(data.timestamp).toLocaleString()}</td></tr>\`;
        statusHtml += '</table>';
        
        document.getElementById('status').innerHTML = statusHtml;
      } catch (error) {
        document.getElementById('status').innerHTML = \`Error fetching status: \${error.message}\`;
      }
    }
    
    // Function to fetch stats
    async function fetchStats() {
      try {
        const response = await fetch('/api/stats');
        const data = await response.json();
        
        if (!data.success) {
          document.getElementById('stats').innerHTML = \`Error: \${data.error}\`;
          return;
        }
        
        let statsHtml = '<table>';
        statsHtml += '<tr><th>Entity</th><th>Last Sync</th><th>Record Count</th><th>Status</th></tr>';
        
        for (const [entity, stats] of Object.entries(data.stats)) {
          statsHtml += \`<tr>
            <td>\${entity}</td>
            <td>\${stats.lastSyncDate ? new Date(stats.lastSyncDate).toLocaleString() : 'Never'}</td>
            <td>\${stats.totalCount}</td>
            <td>\${stats.status}</td>
          </tr>\`;
        }
        
        statsHtml += '</table>';
        statsHtml += \`<p>Sync in progress: \${data.syncInProgress ? 'Yes' : 'No'}</p>\`;
        
        document.getElementById('stats').innerHTML = statsHtml;
        
        // Update button states
        const buttons = document.querySelectorAll('.button');
        buttons.forEach(button => {
          button.disabled = data.syncInProgress;
        });
      } catch (error) {
        document.getElementById('stats').innerHTML = \`Error fetching stats: \${error.message}\`;
      }
    }
    
    // Function to fetch sync results
    async function fetchResults() {
      try {
        const response = await fetch('/api/sync/results');
        const data = await response.json();
        
        if (!data.lastResults || Object.keys(data.lastResults).length === 0) {
          document.getElementById('results').innerHTML = 'No sync results yet';
          return;
        }
        
        let resultsHtml = \`<p>Last sync: \${new Date(data.lastResults.timestamp).toLocaleString()}</p>\`;
        resultsHtml += \`<p>Overall status: \${data.lastResults.success ? 'Success' : 'Failed'}</p>\`;
        
        if (data.lastResults.error) {
          resultsHtml += \`<p>Error: \${data.lastResults.error}</p>\`;
        } else {
          resultsHtml += '<table>';
          resultsHtml += '<tr><th>Entity</th><th>Status</th><th>Count</th><th>Error</th></tr>';
          
          for (const [entity, result] of Object.entries(data.lastResults)) {
            if (entity !== 'timestamp' && entity !== 'success') {
              resultsHtml += \`<tr>
                <td>\${entity}</td>
                <td>\${result.success ? 'Success' : 'Failed'}</td>
                <td>\${result.count || 0}</td>
                <td>\${result.error || ''}</td>
              </tr>\`;
            }
          }
          
          resultsHtml += '</table>';
        }
        
        document.getElementById('results').innerHTML = resultsHtml;
      } catch (error) {
        document.getElementById('results').innerHTML = \`Error fetching results: \${error.message}\`;
      }
    }
    
    // Function to trigger sync
    async function triggerSync(endpoint) {
      try {
        const buttons = document.querySelectorAll('.button');
        buttons.forEach(button => {
          button.disabled = true;
        });
        
        const response = await fetch(\`/api/\${endpoint}\`, {
          method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.success) {
          alert(\`\${data.message}. Check results in a few moments.\`);
        } else {
          alert(\`Error: \${data.error}\`);
        }
        
        // Refresh stats after a delay
        setTimeout(() => {
          fetchStats();
          fetchResults();
        }, 2000);
      } catch (error) {
        alert(\`Error triggering sync: \${error.message}\`);
        
        const buttons = document.querySelectorAll('.button');
        buttons.forEach(button => {
          button.disabled = false;
        });
      }
    }
    
    // Add event listeners
    document.getElementById('sync-all-btn').addEventListener('click', () => triggerSync('sync'));
    document.getElementById('sync-products-btn').addEventListener('click', () => triggerSync('sync/products'));
    document.getElementById('sync-picklists-btn').addEventListener('click', () => triggerSync('sync/picklists'));
    document.getElementById('sync-warehouses-btn').addEventListener('click', () => triggerSync('sync/warehouses'));
    
    // Initial data fetch
    fetchStatus();
    fetchStats();
    fetchResults();
    
    // Refresh data periodically
    setInterval(fetchStatus, 30000);
    setInterval(fetchStats, 10000);
    setInterval(fetchResults, 10000);
  </script>
</body>
</html>
`;

// Write dashboard HTML file
fs.writeFileSync(path.join(dashboardDir, 'dashboard.html'), dashboardHtml);

// Serve static dashboard files
app.use(express.static(path.join(__dirname, 'dashboard')));

// Add explicit route for /dashboard/ path
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'dashboard.html'));
});

app.get('/dashboard/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'dashboard.html'));
});

// Serve dashboard at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'dashboard.html'));
});

// Initialize database and start server
initializeDatabase()
  .then(success => {
    if (success) {
      // Start the server
      app.listen(port, () => {
        console.log(`Simplified Picqer middleware running on port ${port}`);
        console.log(`Dashboard available at: http://localhost:${port}/dashboard/`);
        console.log(`API available at: http://localhost:${port}/api/`);
      });
    } else {
      console.error('Failed to initialize database, server not started');
    }
  })
  .catch(error => {
    console.error('Error during initialization:', error);
  });

module.exports = app;
