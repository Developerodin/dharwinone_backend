import mongoose from 'mongoose';
import Task from '../models/task.model.js';
import config from '../config/config.js';

async function checkTasks() {
  try {
    await mongoose.connect(config.mongoose.url, config.mongoose.options);
    console.log('Connected to MongoDB');

    const tasks = await Task.find({
      assignedTo: { $exists: true, $ne: [] }
    })
      .select('title assignedTo projectId status createdAt')
      .sort('-createdAt')
      .limit(10)
      .lean();

    console.log(`\nFound ${tasks.length} tasks with assignedTo:\n`);
    
    tasks.forEach((task, i) => {
      console.log(`${i + 1}. Task: ${task.title}`);
      console.log(`   ID: ${task._id}`);
      console.log(`   Status: ${task.status}`);
      console.log(`   Project ID: ${task.projectId || 'No project'}`);
      console.log(`   Assigned to (User IDs):`);
      (task.assignedTo || []).forEach(userId => {
        console.log(`     - ${userId}`);
      });
      console.log(`   Created: ${task.createdAt}`);
      console.log('');
    });

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

checkTasks();
