import React, { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { api } from '../utils/api';

const TasksSettingsContext = createContext({
  tasksEnabled: true,
  setTasksEnabled: () => {},
  toggleTasksEnabled: () => {},
  isTaskMasterInstalled: null,
  isTaskMasterReady: null,
  installationStatus: null,
  isCheckingInstallation: true
});

export const useTasksSettings = () => {
  const context = useContext(TasksSettingsContext);
  if (!context) {
    throw new Error('useTasksSettings must be used within a TasksSettingsProvider');
  }
  return context;
};

export const TasksSettingsProvider = ({ children }) => {
  const [tasksEnabled, setTasksEnabled] = useState(() => {
    // Load from localStorage on initialization
    const saved = localStorage.getItem('tasks-enabled');
    return saved !== null ? JSON.parse(saved) : true; // Default to true
  });
  
  const [isTaskMasterInstalled, setIsTaskMasterInstalled] = useState(null);
  const [isTaskMasterReady, setIsTaskMasterReady] = useState(null);
  const [installationStatus, setInstallationStatus] = useState(null);
  const [isCheckingInstallation, setIsCheckingInstallation] = useState(true);
  // This provider sits inside AuthProvider but outside ProtectedRoute, so it
  // mounts on the login screen too — hence the gate in the effect below.
  const { token } = useAuth();

  // Save to localStorage whenever tasksEnabled changes
  useEffect(() => {
    localStorage.setItem('tasks-enabled', JSON.stringify(tasksEnabled));
  }, [tasksEnabled]);

  // Check TaskMaster installation status once there is someone to check for.
  //
  // This used to run on mount with an empty dependency list, which meant it
  // fired on the login screen, took a 401, logged an error, and recorded
  // "TaskMaster is not installed" — permanently, because nothing re-ran it
  // after login. Every install therefore reported Tasks as unavailable, and the
  // only visible symptom was a console error that read like harmless noise.
  useEffect(() => {
    if (!token) {
      // Not an error state: nobody is logged in yet, so there is nothing to
      // probe. Leave the flags null (= "unknown") and wait for the token.
      return;
    }

    let cancelled = false;
    const checkInstallation = async () => {
      try {
        const response = await api.get('/taskmaster/installation-status');
        if (cancelled) return;
        if (response.ok) {
          const data = await response.json();
          if (cancelled) return;
          setInstallationStatus(data);
          setIsTaskMasterInstalled(data.installation?.isInstalled || false);
          setIsTaskMasterReady(data.isReady || false);
          
          // If TaskMaster is not installed and user hasn't explicitly enabled tasks,
          // disable tasks automatically
          const userEnabledTasks = localStorage.getItem('tasks-enabled');
          if (!data.installation?.isInstalled && !userEnabledTasks) {
            setTasksEnabled(false);
          }
        } else {
          console.error('Failed to check TaskMaster installation status:', response.status);
          setIsTaskMasterInstalled(false);
          setIsTaskMasterReady(false);
        }
      } catch (error) {
        if (cancelled) return;
        console.error('Error checking TaskMaster installation:', error);
        setIsTaskMasterInstalled(false);
        setIsTaskMasterReady(false);
      } finally {
        if (!cancelled) setIsCheckingInstallation(false);
      }
    };

    // Run check asynchronously without blocking initial render
    const timer = setTimeout(checkInstallation, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token]);

  const toggleTasksEnabled = () => {
    setTasksEnabled(prev => !prev);
  };

  const contextValue = {
    tasksEnabled,
    setTasksEnabled,
    toggleTasksEnabled,
    isTaskMasterInstalled,
    isTaskMasterReady,
    installationStatus,
    isCheckingInstallation
  };

  return (
    <TasksSettingsContext.Provider value={contextValue}>
      {children}
    </TasksSettingsContext.Provider>
  );
};

export default TasksSettingsContext;