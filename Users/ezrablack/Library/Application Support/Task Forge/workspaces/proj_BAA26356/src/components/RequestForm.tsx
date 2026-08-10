import React, { useState } from 'react';

export const RequestForm: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({ name: '', email: '', message: '' });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    // simulate API
    await new Promise(r => setTimeout(r, 1200));
    setLoading(false);
    alert('Submitted!');
  };

  return (
    <form onSubmit={handleSubmit} className="request-form">
      <div className="form-grid">
        <input type="text" placeholder="Name" value={formData.name} disabled={loading}
          onChange={e => setFormData({...formData, name: e.target.value})} required />
        <input type="email" placeholder="Email" value={formData.email} disabled={loading}
          onChange={e => setFormData({...formData, email: e.target.value})} required />
      </div>
      <textarea placeholder="Message" value={formData.message} disabled={loading}
        onChange={e => setFormData({...formData, message: e.target.value})} required />
      <button type="submit" disabled={loading}>
        {loading ? 'Submitting...' : 'Submit Request'}
      </button>
      {loading && <div className="loading-overlay">Processing...</div>}
    </form>
  );
};
