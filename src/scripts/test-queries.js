import mongoose from 'mongoose';
import Task from '../models/task.model.js';
import config from '../config/config.js';

async function testQueries() {
  try {
    await mongoose.connect(config.mongoose.url, config.mongoose.options);
    console.log('Connected to MongoDB\n');

    const userId = '69a1383799f77434c7a614cb';
    
    console.log('=== Testing Query Formats ===');
    console.log('User ID:', userId);
    console.log('');

    // Test 1: Direct string comparison
    console.log('1. Direct string query { assignedTo: userId }:');
    let tasks = await Task.find({ assignedTo: userId }).select('title assignedTo').lean();
    console.log('   Found:', tasks.length, 'tasks');
    
    // Test 2: Using $in with array
    console.log('\n2. Using $in: { assignedTo: { $in: [userId] } }:');
    tasks = await Task.find({ assignedTo: { $in: [userId] } }).select('title assignedTo').lean();
    console.log('   Found:', tasks.length, 'tasks');
    
    // Test 3: Convert to ObjectId
    console.log('\n3. Using ObjectId: { assignedTo: new ObjectId(userId) }:');
    tasks = await Task.find({ assignedTo: new mongoose.Types.ObjectId(userId) }).select('title assignedTo').lean();
    console.log('   Found:', tasks.length, 'tasks');
    if (tasks.length > 0) {
      console.log('   ✓ Task found:', tasks[0].title);
      console.log('   assignedTo array:', tasks[0].assignedTo.map(id => String(id)));
    }

    // Test 4: Check what the actual query in the service does
    console.log('\n4. Simulating service query (assignedToMe=true):');
    const filter = { assignedTo: userId };
    tasks = await Task.find(filter).select('title').lean();
    console.log('   Found:', tasks.length, 'tasks');

    console.log('\n=== ISSUE IDENTIFIED ===');
    console.log('MongoDB needs ObjectId comparison for array fields!');
    console.log('The service is passing a STRING but MongoDB stores ObjectIds.');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

testQueries();
