import mongoose from 'mongoose';
import User from '../models/user.model.js';
import config from '../config/config.js';

async function checkUsers() {
  try {
    await mongoose.connect(config.mongoose.url, config.mongoose.options);
    console.log('Connected to MongoDB');

    const users = await User.find({
      $or: [
        { name: /prakhar/i },
        { email: /prakhar/i }
      ]
    })
      .select('name email _id roleIds')
      .lean();

    console.log(`\nFound ${users.length} users matching "prakhar":\n`);
    
    users.forEach((user, i) => {
      console.log(`${i + 1}. Name: ${user.name}`);
      console.log(`   Email: ${user.email}`);
      console.log(`   ID: ${user._id}`);
      console.log(`   Role IDs: ${(user.roleIds || []).join(', ')}`);
      console.log('');
    });

    // Check if the task's assigned users match
    const taskAssignedUsers = ['69a1383799f77434c7a614cf', '69a16d0eb5e06be739f8952f'];
    console.log('\nTask is assigned to these user IDs:');
    taskAssignedUsers.forEach(id => console.log(`  - ${id}`));
    console.log('\nDo any Prakhar users match?');
    users.forEach(user => {
      const match = taskAssignedUsers.includes(String(user._id));
      console.log(`  ${user.name} (${user._id}): ${match ? 'YES ✓' : 'NO ✗'}`);
    });

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

checkUsers();
