# Fix for Task Assignments Not Showing in My Projects

## Issue
When you assign candidates to tasks in the task board, the project doesn't appear in the candidate's "My Projects" page.

## Root Cause
The backend server is running old code that doesn't automatically sync task assignees to project assignees.

## Solution

### Step 1: Restart the Backend Server
The backend code has been updated to automatically add task assignees to the parent project. You need to restart the backend server to load this new code.

**Option A: Using nodemon's restart command (recommended)**
1. Click on the backend terminal (Terminal 1 in Cursor)
2. Type `rs` and press Enter
3. Wait for the server to restart

**Option B: Stop and start**
1. Press `Ctrl+C` in the backend terminal to stop the server
2. Run `npm run dev` to start it again

### Step 2: Test with a New Task Assignment
After restarting the backend:
1. Go to the task board as admin
2. Assign a candidate to a task that has a project
3. The candidate will **automatically** be added to the project
4. The project will immediately appear in the candidate's "My Projects" page

### Step 3: Fix Existing Task Assignments (if needed)
If you have tasks that were assigned **before** restarting the server, run the sync script:

```bash
cd "C:\Users\INTEL\Desktop\DHARWIN NEW\uat.dharwin.backend"
node src/scripts/sync-task-assignments.js
```

This will retroactively add all task assignees to their parent projects.

## Current Status
- ✅ Code updated to auto-sync task assignments to projects
- ✅ Sync script created and tested (added 3 assignees to "Dharwin one" project)
- ⏳ **Backend server needs restart to load new code**
- ❌ Latest task edits used old code (server needs restart)

## After Restart
From then on, whenever you:
1. Create a new task with assignees
2. Update a task to add/change assignees

The system will **automatically**:
- Add those assignees to the parent project's `assignedTo` array
- Send them a notification about the project assignment
- Make the project visible in their "My Projects" page

## Troubleshooting

### If the project still doesn't show after restart:
1. Check the backend terminal for errors
2. Verify the candidate is actually assigned to the task
3. Run the sync script manually
4. Ask the candidate to hard-refresh the browser (Ctrl+Shift+R or Ctrl+F5)
5. Check that the project has a valid ID (not null)

### Cache Issues:
If you see "304 Not Modified" in the backend logs but the data should have changed:
1. Hard-refresh the browser (Ctrl+Shift+R)
2. Clear browser cache
3. Use incognito/private browsing mode to test
