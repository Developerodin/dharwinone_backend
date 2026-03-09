import mongoose from 'mongoose';
import Task from '../models/task.model.js';
import config from '../config/config.js';

async function fixTaskAssignments() {
  try {
    await mongoose.connect(config.mongoose.url, config.mongoose.options);
    console.log('Connected to MongoDB');

    // The task "New UI" with wrong candidate IDs
    const taskId = '69a13ad76341c6a8f353d3ec';
    
    // The correct user IDs for Prakhar users
    const correctUserIds = [
      '69a1383799f77434c7a614cb', // Prakhar sharma - prakhar@theodin.in
      '69a16d0eb5e06be739f8952d'  // Prakhar - sharmaprakhar00o07@gmail.com
    ];

    const task = await Task.findById(taskId);
    if (!task) {
      console.log('Task not found!');
      return;
    }

    console.log(`\nFound task: "${task.title}"`);
    console.log(`Current assignedTo:`, task.assignedTo);
    
    // Update the task with correct user IDs
    task.assignedTo = correctUserIds;
    await task.save();
    
    console.log(`\nUpdated assignedTo to:`, task.assignedTo);
    console.log('\n✓ Task assignments fixed!');
    console.log('\nNow the task should appear in "My Tasks" for these users.');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

fixTaskAssignments();
